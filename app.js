// app.js

const MQTT_CLUSTER_HOST  = "675c9b4309ee46008e3a7726f2c1969d.s1.eu.hivemq.cloud"; 	// e.g. xxxxxxx.s1.eu.hivemq.cloud
const MQTT_WS_PORT       = 8884;													// HiveMQ Cloud WebSockets port
const MQTT_USERNAME      = "user1";													// MQTT credential username
const ROOT_TOPIC         = "greenhouse";

// UI elements
const connectionStatusEl = document.getElementById("connectionStatus");
const lastUpdateEl       = document.getElementById("lastUpdate");

const mqttPassphraseEl   = document.getElementById("mqttPassphrase");
const mqttConnectBtn     = document.getElementById("mqttConnectButton");
const mqttErrorEl        = document.getElementById("mqttError");

const lightLuxEl         = document.getElementById("lightLux");
const tempEl             = document.getElementById("temperature");
const humEl              = document.getElementById("humidity");
const soilEl             = document.getElementById("soilMoisture");

const modeRadioAuto      = document.querySelector('input[name="mode"][value="auto"]');
const modeRadioManual    = document.querySelector('input[name="mode"][value="manual"]');

const desiredLightCb     = document.getElementById("desiredLight");
const desiredPumpCb      = document.getElementById("desiredPump");
const sendCommandsBtn    = document.getElementById("sendCommandsButton");

// Timestamp
let lastStatusTimestampMs = null;

// MQTT
let client     = null;
let connected  = false;
let connecting = false;

// Last sensor values
let lastStatusLightLux  = null;
let lastStatusTemp      = null;
let lastStatusHum       = null;
let lastStatusSoil      = null;

// Internal state mirrored from device status
let currentDesiredLight = null; // boolean or null
let currentDesiredPump  = null; // boolean or null
let currentMode         = null; // "auto" | "manual" | null

// Local edit buffer (what the user has set in the checkboxes)
let editedDesiredLight  = null;
let editedDesiredPump   = null;
let editedMode          = null;

// Encrypted MQTT password
const ENCRYPTED_MQTT_PASSWORD = {
	salt: "VQfW9f24CZgN8W7Gb9sjXg==",
	iv:   "/FA+bf8CfA/jtLey",
	data: "KiNmb4e4xW0BRGy7te4M5tkbSKcaSV6XzKImkg=="
};

// MQTT & connection
const mqttUrl = `wss://${MQTT_CLUSTER_HOST}:${MQTT_WS_PORT}/mqtt`;
if (mqttConnectBtn) {
	mqttConnectBtn.addEventListener("click", async () => {
		if (connecting || connected) return;

		if (!mqttPassphraseEl) return;

		const passphrase = mqttPassphraseEl.value;
		if (!passphrase) return;

		connecting = true;
		clearMqttError();
		mqttConnectBtn.disabled = true;
		mqttPassphraseEl.disabled = true;
		connectionStatusEl.textContent = "connecting";

		let mqttPassword;
		try {
			mqttPassword = await decryptMqttPassword(passphrase);
		} catch {
			connecting = false;
			mqttConnectBtn.disabled = false;
			mqttPassphraseEl.disabled = false;
			connectionStatusEl.textContent = "disconnected";
			showMqttError("Wrong passphrase");
			return;
		}

		// Create MQTT client
		if (client) {
			client.end(true);
			client = null;
		}
		client = mqtt.connect(mqttUrl, {
			username: MQTT_USERNAME,
			password: mqttPassword,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 4000
		});

		attachMqttHandlers(client);
	});
}

// Command ID storage
const CMD_ID_KEY = "greenhouse:lastCmdId";
let lastCmdId = Number(localStorage.getItem(CMD_ID_KEY)) || Date.now();
function nextCmdId() {
	lastCmdId = lastCmdId + 1;
	localStorage.setItem(CMD_ID_KEY, String(lastCmdId));
	return lastCmdId;
}

// ---------- Web Crypto ----------
async function decryptMqttPassword(passphrase) {
	try {
		const enc = new TextEncoder();
		const dec = new TextDecoder();

		const salt = Uint8Array.from(atob(ENCRYPTED_MQTT_PASSWORD.salt), c => c.charCodeAt(0));
		const iv   = Uint8Array.from(atob(ENCRYPTED_MQTT_PASSWORD.iv),   c => c.charCodeAt(0));
		const data = Uint8Array.from(atob(ENCRYPTED_MQTT_PASSWORD.data), c => c.charCodeAt(0));

		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			enc.encode(passphrase),
			"PBKDF2",
			false,
			["deriveKey"]
		);

		const key = await crypto.subtle.deriveKey(
			{
				name: "PBKDF2",
				salt,
				iterations: 100000,
				hash: "SHA-256"
			},
			keyMaterial,
			{ name: "AES-GCM", length: 256 },
			false,
			["decrypt"]
		);

		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			key,
			data
		);

		return dec.decode(plaintext);
	} catch (e) {
		throw new Error("decrypt_failed");
	}
}

// ---------- Helpers to update UI ----------
function setText(el, v) {
	if (!el) return;
	if (v === null || v === undefined) el.textContent = "—";
	else el.textContent = String(v);
}

function boolToText(b) {
	if (b === null || b === undefined) return "—";
	return b ? "ON" : "OFF";
}

function showMqttError(message, detail = null) {
	if (!mqttErrorEl) return;

	if (detail) {
		mqttErrorEl.textContent = `${message} (${detail})`;
	} else {
		mqttErrorEl.textContent = message;
	}

	mqttErrorEl.style.display = "block";
}

function clearMqttError() {
	if (!mqttErrorEl) return;
	mqttErrorEl.style.display = "none";
	mqttErrorEl.textContent = "";
}

function updateControlsEnabledState() {
	// Controls editable only if user-selected MODE is "manual" (UI), AND connected
	const uiSelectedManual = modeRadioManual && modeRadioManual.checked;
	const editable = connected && uiSelectedManual;

	if (desiredLightCb) desiredLightCb.disabled = !editable;
	if (desiredPumpCb) desiredPumpCb.disabled = !editable;

	// Send enabled only if editable AND (there is a change to send)
	const modeChange = (editedMode !== null && editedMode !== currentMode);
	const effChange = (() => {
		// if editedDesired is null that means user hasn't touched the checkbox
		const p1 = (editedDesiredLight !== null) && (editedDesiredLight !== currentDesiredLight);
		const p2 = (editedDesiredPump !== null) && (editedDesiredPump !== currentDesiredPump);
		return p1 || p2;
	})();

	sendCommandsBtn.disabled = !(editable && (modeChange || effChange));
}

function applyDeviceStatusToUI() {
	// update DOM values
	setText(lightLuxEl, lastStatusLightLux);
	setText(tempEl, lastStatusTemp);
	setText(humEl, lastStatusHum);
	setText(soilEl, lastStatusSoil);

	// effectors status
	if (currentDesiredLight !== null) {
		desiredLightCb.checked = currentDesiredLight;
	} else {
		desiredLightCb.checked = false;
	}
	if (currentDesiredPump !== null) {
		desiredPumpCb.checked = currentDesiredPump;
	} else {
		desiredPumpCb.checked = false;
	}

	// mode radio should reflect currentMode only as "device reported"; user may choose a different radio before sending.
	if (currentMode === "auto") {
		modeRadioAuto.checked = true;
	} else if (currentMode === "manual") {
		modeRadioManual.checked = true;
	}

	// reset edited buffers
	editedDesiredLight = null;
	editedDesiredPump = null;
	editedMode = null;

	updateControlsEnabledState();
}

function updateLastUpdateText() {
	if (!lastUpdateEl) return;

	if (lastStatusTimestampMs === null) {
		lastUpdateEl.textContent = "—";
		return;
	}

	const deltaSec = Math.floor((Date.now() - lastStatusTimestampMs) / 1000);

	if (deltaSec < 5) {
		lastUpdateEl.textContent = `just now (${deltaSec}s ago)`;
	} else if (deltaSec < 60) {
		lastUpdateEl.textContent = `${deltaSec}s ago`;
	} else {
		const mins = Math.floor(deltaSec / 60);
		lastUpdateEl.textContent = `${mins}m ago`;
	}
}

// ---------- MQTT handlers ----------
function attachMqttHandlers(client) {

	// ---------- MQTT lifecycle ----------
	client.on("connect", () => {
		connected = true;
		connecting = false;
		connectionStatusEl.textContent = "connected";
		mqttConnectBtn.disabled = true; // stay disabled while connected
		mqttPassphraseEl.disabled = true;
		client.subscribe(`${ROOT_TOPIC}/status/#`, { qos: 0 }, (err) => {
		if (err) console.warn("Subscribe error:", err);
		});
		updateLastUpdateText();
		updateControlsEnabledState();
	});

	client.on("reconnect", () => {
		connected = false;
		connecting = true;
		connectionStatusEl.textContent = "reconnecting";
		clearMqttError();
		updateControlsEnabledState();
	});

	client.on("close", () => {
		const wasConnected = connected;

		connected = false;
		connecting = false;
		mqttConnectBtn.disabled = false;
		mqttPassphraseEl.disabled = false;
		connectionStatusEl.textContent = "disconnected";
		lastStatusTimestampMs = null;
		updateLastUpdateText();
		updateControlsEnabledState();

		if (wasConnected) {
			showMqttError("Connection lost");
		}
	});

	client.on("error", (err) => {
		console.error("MQTT error", err);
		if (!connected) {
			connecting = false;
			mqttConnectBtn.disabled = false;
			mqttPassphraseEl.disabled = false;
			connectionStatusEl.textContent = "disconnected";

			const msg = (err && err.message) ? err.message.toLowerCase() : "";


			if (msg.includes("not authorized") || msg.includes("bad user")) {
				showMqttError("Authentication failed");
			} else if (msg.includes("certificate") || msg.includes("tls")) {
				showMqttError("TLS / certificate error");
			} else if (msg.includes("websocket") || msg.includes("socket")) {
				showMqttError("WebSocket connection failed");
			} else {
				showMqttError("Unable to connect to broker", err.message);
			}
		}
	});

	// ---------- Message handling ----------
	client.on("message", (topic, payload) => {
		let msg = null;
		try {
		msg = JSON.parse(payload.toString());
		} catch (e) {
		console.warn("Invalid JSON on", topic, payload.toString());
		return;
		}

		if (topic.startsWith(`${ROOT_TOPIC}/status/`)) {
		lastStatusTimestampMs = Date.now();
		updateLastUpdateText();
		}

		if (topic === `${ROOT_TOPIC}/status/light`) {
		lastStatusLightLux = (msg && typeof msg.lux !== "undefined") ? msg.lux : null;
		setText(lightLuxEl, lastStatusLightLux);
		} else if (topic === `${ROOT_TOPIC}/status/environment`) {
		lastStatusTemp = (msg && typeof msg.temperature_c !== "undefined") ? msg.temperature_c : null;
		lastStatusHum  = (msg && typeof msg.humidity_pct !== "undefined") ? msg.humidity_pct : null;
		setText(tempEl, lastStatusTemp);
		setText(humEl, lastStatusHum);
		} else if (topic === `${ROOT_TOPIC}/status/soil`) {
		lastStatusSoil = (msg && typeof msg.moisture !== "undefined") ? msg.moisture : null;
		setText(soilEl, lastStatusSoil);
		} else if (topic === `${ROOT_TOPIC}/status/effectors`) {
		// authoritative desired effector state from device
		if (msg) {
			if (typeof msg.light_on !== "undefined") {
			currentDesiredLight = !!msg.light_on;
			} else {
			currentDesiredLight = null;
			}
			if (typeof msg.pump_on !== "undefined") {
			currentDesiredPump = !!msg.pump_on;
			} else {
			currentDesiredPump = null;
			}
			if (typeof msg.mode !== "undefined") {
			currentMode = String(msg.mode);
			} else {
			currentMode = null;
			}
		} else {
			currentDesiredLight = null;
			currentDesiredPump = null;
			currentMode = null;
		}

		// Reflect to UI
		applyDeviceStatusToUI();
		} else if (topic === `${ROOT_TOPIC}/status/system`) {
		// ignore for now, could display uptime etc.
		} else {
		// ignore unknown topics
		}
	});
}

// ---------- UI event wiring ----------

// User edits the desired checkboxes: update edited buffer and enable send if allowed
if (desiredLightCb) {
	desiredLightCb.addEventListener("change", () => {
		editedDesiredLight = desiredLightCb.checked;
		updateControlsEnabledState();
	});
}
if (desiredPumpCb) {
	desiredPumpCb.addEventListener("change", () => {
		editedDesiredPump = desiredPumpCb.checked;
		updateControlsEnabledState();
	});
}

// Mode selection (UI side) changes the edit buffer
if (modeRadioAuto && modeRadioManual) {
	modeRadioAuto.addEventListener("change", () => {
		if (modeRadioAuto.checked) editedMode = "auto";
		updateControlsEnabledState();
	});
	modeRadioManual.addEventListener("change", () => {
		if (modeRadioManual.checked) editedMode = "manual";
		updateControlsEnabledState();
	});
}

// Send commands: send cmd/mode first (if needed), then cmd/effectors (if needed).
if (sendCommandsBtn) {
	sendCommandsBtn.addEventListener("click", () => {
		if (!connected) return;

		const toSendMode = (editedMode !== null && editedMode !== currentMode);
		// build desired object from edited values; include only fields that were edited (not null)
		const desiredPayload = {};
		let anyEffEdited = false;
		if (editedDesiredLight !== null) {
			desiredPayload.light_on = !!editedDesiredLight;
			anyEffEdited = true;
		}
		if (editedDesiredPump !== null) {
			desiredPayload.pump_on = !!editedDesiredPump;
			anyEffEdited = true;
		}

		// helper to publish JSON
		function publish(topic, obj) {
			try {
				client.publish(topic, JSON.stringify(obj), { qos: 0, retain: false }, (err) => {
					if (err) console.warn("Publish error", err);
				});
			} catch (e) {
				console.error("Publish exception", e);
			}
		}

		// Sequence: if mode change requested, send it first with its own id.
		if (toSendMode) {
			const payload = { id: nextCmdId(), mode: editedMode };
			publish(`${ROOT_TOPIC}/cmd/mode`, payload)
			currentMode = editedMode;
		}

		// Send effectors command if user edited effectors
		if (anyEffEdited) {
			const payload = { id: nextCmdId(), desired: desiredPayload };
			publish(`${ROOT_TOPIC}/cmd/effectors`, payload);
		}

		// Clear edited buffers
		editedDesiredLight = null;
		editedDesiredPump = null;
		editedMode = null;

		// Update UI: disable checkboxes unless UI still in manual selection, recompute send button state
		applyDeviceStatusToUI();
	});
}

// Initial UI state
setText(lightLuxEl, null);
setText(tempEl, null);
setText(humEl, null);
setText(soilEl, null);
connectionStatusEl.textContent = "disconnected";
desiredLightCb.disabled = true;
desiredPumpCb.disabled = true;
sendCommandsBtn.disabled = true;
setInterval(updateLastUpdateText, 1000);
