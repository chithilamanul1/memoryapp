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
import * as qrcode from "qrcode-terminal";
import path from "path";
import { registerMessageHandler } from "./messageHandler";

/** Directory where Baileys persists multi-file auth credentials. */
const AUTH_DIR = path.resolve(process.cwd(), "auth_info");

/** Pino logger — set to 'silent' to suppress Baileys' very verbose internals. */
const logger = pino({ level: "silent" });

/** Shared socket reference accessible by other modules via getSocket(). */
let activeSock: WASocket | null = null;

/**
 * Returns the currently active Baileys WASocket, or null if disconnected.
 * Used by the reminder worker to send scheduled messages.
 */
export function getSocket(): WASocket | null {
  return activeSock;
}

/**
 * Initialises the Baileys WhatsApp connection.
 *
 * On first run, a QR code is printed to the terminal for scanning.
 * On subsequent runs, saved credentials are reused automatically.
 * If the connection drops (and the user hasn't logged out), it reconnects.
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
    printQRInTerminal: false, // We handle QR display ourselves
    logger,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
  });

  // ── Connection lifecycle events ──────────────────────────────────────

  activeSock.ev.on(
    "connection.update",
    async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      // Display QR code for pairing
      if (qr) {
        console.log("\n📱 Scan this QR code with WhatsApp to connect:\n");
        qrcode.generate(qr, { small: true });
        console.log(""); // Blank line after QR for readability
      }

      if (connection === "close") {
        const statusCode =
          (lastDisconnect?.error as Boom)?.output?.statusCode ??
          DisconnectReason.connectionLost;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp] Connection closed (code: ${statusCode}). ` +
            `${shouldReconnect ? "Reconnecting..." : "Logged out — will not reconnect."}`
        );

        if (shouldReconnect) {
          // Small delay before reconnecting to avoid rapid retry loops
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
        console.log("[WhatsApp] ✅ Connected and ready to receive messages!");
      }
    }
  );

  // Persist credentials whenever they update (e.g. key rotation)
  activeSock.ev.on("creds.update", saveCreds);

  // Register the message handler on this socket
  registerMessageHandler(activeSock);
}
