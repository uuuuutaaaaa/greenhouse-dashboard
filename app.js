// app.js

const MQTT_CLUSTER_HOST  = "675c9b4309ee46008e3a7726f2c1969d.s1.eu.hivemq.cloud";
const MQTT_WS_PORT       = 8884; // HiveMQ Cloud WebSockets port
const MQTT_USERNAME      = "user1";
const ROOT_TOPIC         = "greenhouse";

// UI elements
const connectionStatusEl        = document.getElementById("connectionStatus");
const lastUpdateEl              = document.getElementById("lastUpdate");

const mqttPassphraseEl          = document.getElementById("mqttPassphrase");
const mqttConnectBtn            = document.getElementById("mqttConnectButton");
const mqttErrorEl               = document.getElementById("mqttError");

const lightLuxEl                = document.getElementById("lightLux");
const tempEl                    = document.getElementById("temperature");
const humEl                     = document.getElementById("humidity");
const soilEl                    = document.getElementById("soilMoisture");
const envTimestampEl            = document.getElementById("envTimestamp");

const uptimeEl                  = document.getElementById("uptime");
const controlModeEl             = document.getElementById("controlMode");
const lightStateEl              = document.getElementById("lightState");
const pumpStateEl               = document.getElementById("pumpState");
const sysTimestampEl            = document.getElementById("sysTimestamp");

const modeRadioAuto             = document.querySelector('input[name="mode"][value="auto"]');
const modeRadioManual           = document.querySelector('input[name="mode"][value="manual"]');

const commandDesiredLightCb     = document.getElementById("desiredLight");
const commandDesiredPumpCb      = document.getElementById("desiredPump");
const commandSendBtn            = document.getElementById("sendCommandsButton");

// Timestamp
let lastStatusTimestampMs       = null;

// MQTT statuses
let client     = null;
let connected  = false;
let connecting = false;

// Last sensor values
let lastStatusLightLux  = null;
let lastStatusTemp      = null;
let lastStatusHum       = null;
let lastStatusSoil      = null;
let lastSensorTimestamp = null; // seconds


// Last device state
let lastUptime          = null; // number or null
let lastDesiredLight    = null; // boolean or null
let lastDesiredPump     = null; // boolean or null
let lastMode            = null; // "auto" | "manual" | null
let lastSystemTimestamp = null; // seconds

// Edited device state from Commands
let commandDesiredLight  = false;
let commandDesiredPump   = false;
let commandMode          = "auto";

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

if (mqttPassphraseEl) {
	mqttPassphraseEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			mqttConnectBtn?.click();
		}
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

function valueToText(b) {
	if (b === null || b === undefined) return "—";
	if (typeof b === "boolean") return b ? "ON" : "OFF";
	if (typeof b === "number") {
		if (b % 1 === 0) return String(b);
		return b.toFixed(2);
	}
	return String(b);
}

function displayTime(seconds) {
	if (seconds === null || seconds === undefined) return "—";
	seconds = Number(seconds);
	if (Number.isNaN(seconds)) return "—";
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor((seconds % 3600) / 60);
	if (seconds < 3600) return `${m}m ${seconds % 60}s`;
	const h = Math.floor(seconds / 3600);
	return `${h}h ${m}m ${seconds % 60}s`;
}

function displayDateAndTimeSince(unixTimestampSeconds) {
	if (unixTimestampSeconds === null ||
		unixTimestampSeconds === undefined ||
		Number.isNaN(unixTimestampSeconds ||
		unixTimestampSeconds <= 1609459200 // 2021-01-01
		)) return "—";
	const d = new Date(unixTimestampSeconds * 1000);
	const options = {
		timeZone: 'Asia/Jakarta',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: true,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	};
	return `${d.toLocaleDateString('en-US', options)}`; // WIB-7
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
	const uiSelectedManual = modeRadioManual && modeRadioManual.checked;
	const editable = connected && uiSelectedManual;

	if (commandDesiredLightCb) commandDesiredLightCb.disabled = !editable;
	if (commandDesiredPumpCb) commandDesiredPumpCb.disabled = !editable;
	if (commandSendBtn) commandSendBtn.disabled = !connected;
}

function applyDeviceStatusToUI() {
	if (!(lastStatusLightLux === null || lastStatusLightLux === undefined || lastStatusLightLux === -1)) {
		setText(lightLuxEl, valueToText(lastStatusLightLux));
	} // -1 == BH1750 didn't read
	setText(tempEl, valueToText(lastStatusTemp));
	setText(humEl, valueToText(lastStatusHum));
	setText(soilEl, valueToText(lastStatusSoil));
	setText(envTimestampEl, displayDateAndTimeSince(lastSensorTimestamp));
	setText(uptimeEl, displayTime(lastUptime));
	setText(lightStateEl, valueToText(lastDesiredLight));
	setText(pumpStateEl, valueToText(lastDesiredPump));
	setText(controlModeEl, valueToText(lastMode));
	setText(sysTimestampEl, displayDateAndTimeSince(lastSystemTimestamp));
	updateLastUpdateText();
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
	} else {
		lastUpdateEl.textContent = `${displayTime(deltaSec)} ago`;
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
		let changed = false;
		try {
			msg = JSON.parse(payload.toString());
		} catch (e) {
			console.warn("Invalid JSON on", topic, payload.toString());
			return;
		}

		if (topic.startsWith(`${ROOT_TOPIC}/status/`)) {
			lastStatusTimestampMs = Date.now();
			changed = true;
		}

		// helper to update last status values
		function ifMsgValueElseNull(value) {
			return (msg && typeof msg[value] !== "undefined") ? msg[value] : null;
		}

		if (topic === `${ROOT_TOPIC}/status/sensors`) {
			lastStatusLightLux  = ifMsgValueElseNull("lux");
			lastStatusTemp      = ifMsgValueElseNull("temperature_c");
			lastStatusHum       = ifMsgValueElseNull("humidity_pct");
			lastStatusSoil      = ifMsgValueElseNull("soil_moisture_pct");
			lastSensorTimestamp = ifMsgValueElseNull("timestamp");
		} else if (topic === `${ROOT_TOPIC}/status/effectors`) {
			lastDesiredLight    = ifMsgValueElseNull("light_on");
			lastDesiredPump     = ifMsgValueElseNull("pump_on");
			lastMode            = ifMsgValueElseNull("mode");
			lastSystemTimestamp = ifMsgValueElseNull("timestamp");
		} else if (topic === `${ROOT_TOPIC}/status/system`) {
			lastUptime          = ifMsgValueElseNull("uptime_s");
			lastSystemTimestamp = ifMsgValueElseNull("timestamp");

		} else {
			// ignore unknown topics
		}

		if (changed) applyDeviceStatusToUI();
	});
}

// ---------- UI event wiring ----------

// User edits the desired checkboxes: update edited buffer and enable send if allowed
if (commandDesiredLightCb) {
	commandDesiredLightCb.addEventListener("change", () => {
		commandDesiredLight = commandDesiredLightCb.checked;
		updateControlsEnabledState();
	});
}
if (commandDesiredPumpCb) {
	commandDesiredPumpCb.addEventListener("change", () => {
		commandDesiredPump = commandDesiredPumpCb.checked;
		updateControlsEnabledState();
	});
}

// Mode selection (UI side) changes the edit buffer
if (modeRadioAuto && modeRadioManual) {
	modeRadioAuto.addEventListener("change", () => {
		if (modeRadioAuto.checked) commandMode = "auto";
		updateControlsEnabledState();
	});
	modeRadioManual.addEventListener("change", () => {
		if (modeRadioManual.checked) commandMode = "manual";
		updateControlsEnabledState();
	});
}

// Send commands: send cmd/mode first (if needed), then cmd/effectors (if needed).
if (commandSendBtn) {
	commandSendBtn.addEventListener("click", () => {
		if (!connected) return;

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

		const modePayload = { id: nextCmdId(), mode: commandMode };
		publish(`${ROOT_TOPIC}/cmd/mode`, modePayload);

		if (commandMode === "auto") return;
		// if you send an effector payload it automatically overrides the mode into "manual"
		const effectorPayload = {
			id: nextCmdId(),
			desired: {
			"light_on": commandDesiredLight, "pump_on": commandDesiredPump
			}
		};
		publish(`${ROOT_TOPIC}/cmd/effectors`, effectorPayload);
	});
}

// Initial UI state
setText(lightLuxEl, null);
setText(tempEl, null);
setText(humEl, null);
setText(soilEl, null);
setText(uptimeEl, null);
setText(controlModeEl, null);
setText(lightStateEl, null);
setText(pumpStateEl, null);
connectionStatusEl.textContent = "disconnected";
if (commandDesiredLightCb) {
  commandDesiredLightCb.checked = !!commandDesiredLight;
  commandDesiredLightCb.disabled = true;
}
if (commandDesiredPumpCb) {
  commandDesiredPumpCb.checked = !!commandDesiredPump;
  commandDesiredPumpCb.disabled = true;
}
if (commandSendBtn) {
  commandSendBtn.disabled = true;
}
setInterval(updateLastUpdateText, 1000);
