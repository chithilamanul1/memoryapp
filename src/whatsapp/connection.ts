/**
 * WhatsApp Connection — Baileys Initialisation
 *
 * Sets up a persistent WhatsApp Web connection using multi-file auth state.
 * Handles QR code display, credential persistence, and automatic reconnection
 * on non-fatal disconnects.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import * as qrcodeTerminal from "qrcode-terminal";
import path from "path";
import { registerMessageHandler } from "./messageHandler";

/** Directory where Baileys persists multi-file auth credentials. */
const AUTH_DIR = path.resolve(process.cwd(), "auth_info");

const logger = pino({ level: "silent" });

let activeSock: WASocket | null = null;
let latestQR: string | null = null;
let isConnected = false;

/** Returns the currently active Baileys WASocket. */
export function getSocket(): WASocket | null {
  return activeSock;
}

/** Returns the latest connection QR code if waiting for login. */
export function getLatestQR(): string | null {
  return latestQR;
}

/** Returns true if the WhatsApp connection is active and authenticated. */
export function isWhatsAppConnected(): boolean {
  return isConnected && !!activeSock;
}

/**
 * Initialises the Baileys WhatsApp connection.
 */
export async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version: [number, number, number];
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log(`[WhatsApp] Using WA Web version: ${version.join(".")}`);
  } catch {
    version = [2, 3000, 1015901307]; // Fallback version
    console.warn("[WhatsApp] Could not fetch latest version, using fallback");
  }

  activeSock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
  });

  // ── Connection lifecycle events ──────────────────────────────────────

  activeSock.ev.on(
    "connection.update",
    async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;
        console.log("\n📱 Scan this QR code with WhatsApp to connect:\n");
        qrcodeTerminal.generate(qr, { small: true });
        console.log("");
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode =
          (lastDisconnect?.error as Boom)?.output?.statusCode ??
          DisconnectReason.connectionLost;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp] Connection closed (code: ${statusCode}). ` +
            `${shouldReconnect ? "Reconnecting..." : "Logged out — will not reconnect."}`
        );

        if (shouldReconnect) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await startWhatsApp();
        } else {
          console.error(
            "[WhatsApp] Session logged out. Delete the 'auth_info' directory and restart to re-pair."
          );
          process.exit(1);
        }
      }

      if (connection === "open") {
        isConnected = true;
        latestQR = null; // Clear QR on success
        console.log("[WhatsApp] ✅ Connected and ready to receive messages!");
      }
    }
  );

  activeSock.ev.on("creds.update", saveCreds);

  registerMessageHandler(activeSock);
}
