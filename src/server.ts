/**
 * Web Dashboard & OAuth callback server
 *
 * Provides a sleek dashboard for:
 *   - Monitoring WhatsApp connection status
 *   - Rendering real-time QR pairing codes
 *   - Initiating and completing Google OAuth linking per user
 *   - Visualizing tasks and database statistics
 */

import express from "express";
import QRCode from "qrcode";
import { PrismaClient } from "@prisma/client";
import { getLatestQR, isWhatsAppConnected } from "./whatsapp/connection";
import { getGoogleAuthUrl, getTokensFromCode, getUserEmail, isGoogleConfigured } from "./services/google.service";

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Main HTML Dashboard endpoint
app.get("/", async (req, res) => {
  try {
    const connected = isWhatsAppConnected();
    const qrRaw = getLatestQR();
    let qrImageBase64: string | null = null;

    if (!connected && qrRaw) {
      qrImageBase64 = await QRCode.toDataURL(qrRaw);
    }

    const users = await prisma.user.findMany({
      include: {
        _count: {
          select: { tasks: true },
        },
      },
    });

    const totalTasks = await prisma.task.count();
    const completedTasks = await prisma.task.count({ where: { completed: true } });
    const pendingTasks = totalTasks - completedTasks;

    const recentTasks = await prisma.task.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { user: true },
    });

    const googleActive = isGoogleConfigured();

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sera Second Brain — Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Outfit', sans-serif;
      background: radial-gradient(circle at top left, #120e24, #0b0716);
    }
  </style>
</head>
<body class="min-h-screen text-gray-100 flex flex-col">

  <!-- Header -->
  <header class="border-b border-white/10 bg-black/30 backdrop-blur-md px-8 py-4 flex items-center justify-between sticky top-0 z-50">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 to-pink-500 flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-purple-500/20">
        🧠
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">Sera</h1>
        <p class="text-xs text-gray-400 font-medium">Second Brain Control Center</p>
      </div>
    </div>
    <div class="flex items-center space-x-4">
      <span class="flex items-center space-x-2 text-sm bg-white/5 border border-white/10 px-3 py-1.5 rounded-full">
        <span class="w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500 shadow-lg shadow-emerald-500/50' : 'bg-rose-500 animate-pulse'}"></span>
        <span class="text-gray-300 font-medium">${connected ? 'WA Connected' : 'WA Disconnected'}</span>
      </span>
      <span class="flex items-center space-x-2 text-sm bg-white/5 border border-white/10 px-3 py-1.5 rounded-full">
        <span class="w-2.5 h-2.5 rounded-full ${googleActive ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
        <span class="text-gray-300 font-medium">${googleActive ? 'Google Active' : 'Google Disabled'}</span>
      </span>
    </div>
  </header>

  <main class="flex-grow p-8 max-w-7xl mx-auto w-full space-y-8">
    <!-- Success/Error Banners -->
    ${req.query.success ? `
      <div class="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-5 py-4 rounded-2xl flex items-center space-x-3">
        <span class="text-xl">✅</span>
        <span class="font-medium">${req.query.success}</span>
      </div>
    ` : ''}
    ${req.query.error ? `
      <div class="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-5 py-4 rounded-2xl flex items-center space-x-3">
        <span class="text-xl">⚠️</span>
        <span class="font-medium">${req.query.error}</span>
      </div>
    ` : ''}

    <!-- Stat Grid -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
      <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
        <p class="text-gray-400 text-sm font-semibold uppercase tracking-wider">Total Users</p>
        <p class="text-4xl font-bold mt-2">${users.length}</p>
      </div>
      <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
        <p class="text-gray-400 text-sm font-semibold uppercase tracking-wider">Total Tasks</p>
        <p class="text-4xl font-bold mt-2 text-purple-400">${totalTasks}</p>
      </div>
      <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
        <p class="text-gray-400 text-sm font-semibold uppercase tracking-wider">Pending Alerts</p>
        <p class="text-4xl font-bold mt-2 text-amber-400">${pendingTasks}</p>
      </div>
      <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
        <p class="text-gray-400 text-sm font-semibold uppercase tracking-wider">Completed Logs</p>
        <p class="text-4xl font-bold mt-2 text-emerald-400">${completedTasks}</p>
      </div>
    </div>

    <!-- Main Content Section split -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      
      <!-- Left / Center: Users list & Tasks -->
      <div class="lg:col-span-2 space-y-8">
        
        <!-- Users Management Card -->
        <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md overflow-hidden">
          <h2 class="text-lg font-bold mb-4 flex items-center space-x-2">
            <span>👥</span>
            <span>Registered Users & Integrations</span>
          </h2>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="border-b border-white/10 text-gray-400 text-sm">
                  <th class="pb-3 font-semibold">User</th>
                  <th class="pb-3 font-semibold">JID</th>
                  <th class="pb-3 font-semibold">Google Sync</th>
                  <th class="pb-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5 text-sm">
                ${users.length === 0 ? `
                  <tr>
                    <td colspan="4" class="py-6 text-center text-gray-500">No users found. Send a message to the bot to create a user!</td>
                  </tr>
                ` : users.map(u => {
                  const googleAuthUrl = getGoogleAuthUrl(u.whatsappJid);
                  return `
                    <tr>
                      <td class="py-4 font-semibold text-gray-200">${u.name || 'Anonymous User'}</td>
                      <td class="py-4 text-gray-400 font-mono text-xs">${u.whatsappJid}</td>
                      <td class="py-4">
                        ${u.googleEmail ? `
                          <span class="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-semibold">
                            📧 ${u.googleEmail}
                          </span>
                        ` : `
                          <span class="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-3 py-1 rounded-full text-xs font-semibold">
                            Not Connected
                          </span>
                        `}
                      </td>
                      <td class="py-4 text-right">
                        ${googleActive ? `
                          ${u.googleEmail ? `
                            <a href="/unlink-google?jid=${u.whatsappJid}" class="text-rose-400 hover:underline font-semibold">Unlink</a>
                          ` : `
                            <a href="${googleAuthUrl}" class="bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold shadow-lg shadow-purple-600/15">Link Google</a>
                          `}
                        ` : `
                          <span class="text-gray-500 text-xs">Configure OAuth keys</span>
                        `}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Recent Tasks List -->
        <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
          <h2 class="text-lg font-bold mb-4 flex items-center space-x-2">
            <span>📝</span>
            <span>Recent Brain Inputs</span>
          </h2>
          <div class="space-y-4">
            ${recentTasks.length === 0 ? `
              <p class="text-gray-500 text-center py-4">No recent tasks or brain inputs found.</p>
            ` : recentTasks.map(t => `
              <div class="flex items-start justify-between bg-white/5 border border-white/5 p-4 rounded-xl">
                <div>
                  <div class="flex items-center space-x-2">
                    <span class="bg-purple-500/20 border border-purple-500/35 text-purple-300 text-xs px-2 py-0.5 rounded font-semibold uppercase tracking-wider">${t.category}</span>
                    <span class="text-gray-400 text-xs">${t.user.name || t.user.whatsappJid}</span>
                  </div>
                  <p class="text-gray-200 mt-2 font-medium">${t.title}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-500">${new Date(t.createdAt).toLocaleDateString()}</p>
                  ${t.dueAt ? `<p class="text-xs text-amber-400 mt-1">⏰ ${new Date(t.dueAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

      </div>

      <!-- Right: WhatsApp Connection QR status -->
      <div>
        <div class="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md flex flex-col items-center justify-center sticky top-24">
          <h2 class="text-lg font-bold mb-4 text-center">WhatsApp Connection</h2>
          
          ${connected ? `
            <div class="text-center py-8">
              <div class="w-20 h-20 rounded-full bg-emerald-500/10 border-2 border-emerald-500/20 flex items-center justify-center text-4xl mx-auto shadow-lg shadow-emerald-500/10 animate-bounce">
                🛡️
              </div>
              <p class="text-emerald-400 font-bold mt-4">Linked & Running</p>
              <p class="text-sm text-gray-400 mt-2">Active daemon is listening for tasks.</p>
            </div>
          ` : `
            ${qrImageBase64 ? `
              <div class="bg-white p-3 rounded-2xl border border-white/10 shadow-xl max-w-[240px]">
                <img src="${qrImageBase64}" alt="WhatsApp QR Code" class="w-full h-auto">
              </div>
              <p class="text-amber-400 font-bold text-center mt-4">Scan QR to Pair</p>
              <p class="text-xs text-gray-400 text-center mt-2 max-w-xs">Open WhatsApp → Linked Devices → Link a Device to scan.</p>
            ` : `
              <div class="text-center py-8 flex flex-col items-center">
                <div class="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                <p class="text-gray-400 mt-4 font-medium">Waiting for QR code generation...</p>
              </div>
            `}
          `}
        </div>
      </div>

    </div>
  </main>

  <footer class="border-t border-white/5 py-6 px-8 text-center text-xs text-gray-600">
    <p>Sera Second Brain — Built with Baileys, Prisma, Redis, & OpenRouter</p>
  </footer>

  <script>
    // Live update every 5 seconds to catch connection change or QR generation
    setInterval(() => {
      // Avoid reloading if user is filling forms (not present currently)
      window.location.reload();
    }, 5000);
  </script>
</body>
</html>
    `;

    res.send(html);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(500).send(`Error rendering dashboard: ${errMsg}`);
  }
});

// OAuth Callback handler from Google Authorization page
app.get("/oauth2callback", async (req, res) => {
  const { code, state: whatsappJid } = req.query;

  if (!code || !whatsappJid) {
    return res.redirect("/?error=" + encodeURIComponent("Invalid callback params. Missing code or state."));
  }

  try {
    const tokens = await getTokensFromCode(code as string);
    const email = await getUserEmail(tokens.refresh_token);

    if (!email) {
      throw new Error("Unable to retrieve email from authorized Google Account.");
    }

    // Save tokens on the matching User record in MongoDB
    await prisma.user.update({
      where: { whatsappJid: whatsappJid as string },
      data: {
        googleRefreshToken: tokens.refresh_token,
        googleEmail: email,
      },
    });

    console.log(`[OAuth] Successfully linked Google Account (${email}) to JID: ${whatsappJid}`);
    res.redirect("/?success=" + encodeURIComponent(`Successfully linked ${email} to ${whatsappJid}!`));
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[OAuth Callback Error]", errMsg);
    res.redirect("/?error=" + encodeURIComponent(`OAuth Linking Failed: ${errMsg}`));
  }
});

// Unlink Google account endpoint
app.get("/unlink-google", async (req, res) => {
  const { jid } = req.query;

  if (!jid) {
    return res.redirect("/?error=" + encodeURIComponent("Missing user JID."));
  }

  try {
    await prisma.user.update({
      where: { whatsappJid: jid as string },
      data: {
        googleRefreshToken: null,
        googleEmail: null,
      },
    });

    res.redirect("/?success=" + encodeURIComponent(`Successfully unlinked Google Account for ${jid}`));
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.redirect("/?error=" + encodeURIComponent(`Unlinking Failed: ${errMsg}`));
  }
});

/**
 * Boots the web dashboard server.
 */
export function startWebServer(): void {
  app.listen(PORT, () => {
    console.log(`[Dashboard] ✅ Web server running at http://localhost:${PORT}`);
  });
}
