import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type {
  CsChatContext,
  OrderRecord,
  RobloxProfile,
  TopUpMethod,
} from './src/types/store.ts';
import {
  ALL_PAYMENT_CHANNELS,
  calculatePricing,
  FALLBACK_AVATAR_URL,
  formatIdr,
  formatRobux,
  getOrderStages,
} from './src/data/catalog.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

// In-memory store state with realistic seeded data
let readyStock = 184500;
const avgProcessMinutes = 4;
const baseRateIdr = 135;

const SEEDED_PROFILES: Record<string, RobloxProfile> = {
  builderman: {
    userId: 156,
    username: 'Builderman',
    displayName: 'Builderman',
    avatarUrl: FALLBACK_AVATAR_URL,
    verifiedSource: 'preview',
  },
  roblox: {
    userId: 1,
    username: 'Roblox',
    displayName: 'Roblox',
    avatarUrl: FALLBACK_AVATAR_URL,
    verifiedSource: 'preview',
  },
  rakabloxid: {
    userId: 492817304,
    username: 'RakaBloxID',
    displayName: 'Raka Pratama',
    avatarUrl: FALLBACK_AVATAR_URL,
    verifiedSource: 'preview',
  },
};

const ordersStore = new Map<string, OrderRecord>();

function seedInitialOrders() {
  const now = Date.now();
  const sample1: OrderRecord = {
    invoiceId: 'INV-8824',
    username: 'Builderman',
    profile: SEEDED_PROFILES.builderman,
    method: 'gamepass',
    netRobux: 800,
    gamepassPrice: 1143,
    gamepassUrl: 'https://www.roblox.com/game-pass/904218824',
    paymentChannelId: 'qris-instan',
    paymentChannelName: 'QRIS All Payment',
    paymentCode: 'ID1026IMOSTORE8824',
    subtotalIdr: 108000,
    discountIdr: 0,
    adminFeeIdr: 0,
    totalIdr: 108000,
    statusStep: 3, // Masa Pending 5 Hari
    createdAt: new Date(now - 1000 * 60 * 60 * 36).toISOString(),
    updatedAt: new Date(now - 1000 * 60 * 60 * 35).toISOString(),
    expiresAt: new Date(now - 1000 * 60 * 60 * 35).toISOString(),
  };

  const sample2: OrderRecord = {
    invoiceId: 'INV-8719',
    username: 'RakaBloxID',
    profile: SEEDED_PROFILES.rakabloxid,
    method: 'login',
    netRobux: 1700,
    paymentChannelId: 'va-bca',
    paymentChannelName: 'BCA Virtual Account',
    paymentCode: '880100008719',
    subtotalIdr: 251600,
    discountIdr: 7548,
    adminFeeIdr: 2500,
    totalIdr: 246552,
    statusStep: 4, // Selesai
    createdAt: new Date(now - 1000 * 60 * 60 * 72).toISOString(),
    updatedAt: new Date(now - 1000 * 60 * 60 * 71).toISOString(),
    expiresAt: new Date(now - 1000 * 60 * 60 * 71).toISOString(),
  };

  ordersStore.set(sample1.invoiceId, sample1);
  ordersStore.set(sample2.invoiceId, sample2);
}

seedInitialOrders();

function hashUsernameToId(username: string): number {
  let hash = 2166136261;
  for (let i = 0; i < username.length; i += 1) {
    hash ^= username.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 100000000 + (Math.abs(hash) % 899999999);
}

async function fetchRobloxProfile(rawUsername: string): Promise<{
  profile?: RobloxProfile;
  notFound?: boolean;
  error?: string;
}> {
  const clean = rawUsername.trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(clean)) {
    return {
      error: 'Format username Roblox tidak valid (3–20 karakter huruf, angka, atau underscore).',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const userRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        usernames: [clean],
        excludeBannedUsers: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (userRes.ok) {
      const payload = (await userRes.json()) as {
        data?: Array<{ id: number; name: string; displayName: string }>;
      };
      const matched = payload.data?.[0];
      if (!matched) {
        return { notFound: true };
      }

      let avatarUrl = FALLBACK_AVATAR_URL;
      try {
        const thumbController = new AbortController();
        const thumbTimer = setTimeout(() => thumbController.abort(), 2800);
        const thumbRes = await fetch(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${matched.id}&size=150x150&format=Png&isCircular=false`,
          { signal: thumbController.signal }
        );
        clearTimeout(thumbTimer);
        if (thumbRes.ok) {
          const thumbPayload = (await thumbRes.json()) as {
            data?: Array<{ state: string; imageUrl?: string }>;
          };
          const imageUrl = thumbPayload.data?.[0]?.imageUrl;
          if (imageUrl) {
            avatarUrl = imageUrl;
          }
        }
      } catch {
        // Keep generated fallback portrait if thumbnail CDN fails
      }

      return {
        profile: {
          userId: matched.id,
          username: matched.name,
          displayName: matched.displayName || matched.name,
          avatarUrl,
          verifiedSource: 'roblox',
        },
      };
    }
  } catch {
    clearTimeout(timer);
  }

  // Deterministic resilient fallback when external network / Roblox API is unavailable
  const seeded = SEEDED_PROFILES[clean.toLowerCase()];
  if (seeded) {
    return { profile: seeded };
  }

  return {
    profile: {
      userId: hashUsernameToId(clean),
      username: clean,
      displayName: clean,
      avatarUrl: FALLBACK_AVATAR_URL,
      verifiedSource: 'preview',
    },
  };
}

function generateInvoiceId(): string {
  for (let i = 0; i < 15; i += 1) {
    const code = Math.floor(1000 + Math.random() * 9000);
    const id = `INV-${code}`;
    if (!ordersStore.has(id)) return id;
  }
  return `INV-${Date.now().toString().slice(-4)}`;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/store/status', (_req, res) => {
    res.json({
      readyStock,
      avgProcessMinutes,
      baseRateIdr,
      updatedAt: new Date().toISOString(),
    });
  });

  app.post('/api/roblox/verify', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const result = await fetchRobloxProfile(username);

    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    if (result.notFound) {
      res.status(404).json({
        error: 'Akun Roblox tidak ditemukan. Periksa kembali ejaan username Anda.',
      });
      return;
    }

    res.json({ profile: result.profile });
  });

  app.get('/api/orders', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const allOrders = Array.from(ordersStore.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    if (!query) {
      res.json({ orders: allOrders.slice(0, 8) });
      return;
    }

    const filtered = allOrders.filter(
      (order) =>
        order.invoiceId.toLowerCase().includes(query) ||
        order.username.toLowerCase().includes(query) ||
        order.profile.displayName.toLowerCase().includes(query)
    );

    res.json({ orders: filtered });
  });

  app.post('/api/orders', (req, res) => {
    const body = req.body as {
      profile?: RobloxProfile;
      method?: TopUpMethod;
      netRobux?: number;
      paymentChannelId?: string;
      gamepassUrl?: string;
      loginNote?: string;
    };

    if (!body.profile || !body.profile.username || !body.profile.userId) {
      res.status(400).json({ error: 'Silakan verifikasi akun Roblox terlebih dahulu.' });
      return;
    }

    const method: TopUpMethod =
      body.method === 'login' || body.method === 'username' ? body.method : 'gamepass';
    const netRobux = Number(body.netRobux || 0);

    if (!Number.isFinite(netRobux) || netRobux < 50 || netRobux > 20000) {
      res.status(400).json({ error: 'Nominal Robux harus berada di antara 50 hingga 20.000 R$.' });
      return;
    }

    const requestedChannel = ALL_PAYMENT_CHANNELS.find(
      (c) => c.id === body.paymentChannelId
    );
    if (requestedChannel?.disabled) {
      res.status(400).json({
        error: `${requestedChannel.name} sedang gangguan. Silakan pilih GoPay atau SeaBank.`,
      });
      return;
    }

    const channel =
      requestedChannel ||
      ALL_PAYMENT_CHANNELS.find((c) => !c.disabled) ||
      ALL_PAYMENT_CHANNELS[0];

    const pricing = calculatePricing(method, netRobux, channel);
    const invoiceId = generateInvoiceId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const numericSuffix = invoiceId.replace('INV-', '');

    const order: OrderRecord = {
      invoiceId,
      username: body.profile.username,
      profile: body.profile,
      method,
      netRobux: pricing.netRobux,
      gamepassPrice: method === 'gamepass' ? pricing.gamepassGrossRobux : undefined,
      gamepassUrl: body.gamepassUrl?.trim() || undefined,
      loginNote: body.loginNote?.trim() || undefined,
      paymentChannelId: channel.id,
      paymentChannelName: channel.name,
      paymentCode: channel.accountNumber || `${channel.accountPrefix}${numericSuffix}`,
      paymentAccountHolder: channel.accountHolder,
      subtotalIdr: pricing.subtotalIdr,
      discountIdr: pricing.discountIdr,
      adminFeeIdr: pricing.adminFeeIdr,
      totalIdr: pricing.totalIdr,
      statusStep: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    ordersStore.set(invoiceId, order);
    readyStock = Math.max(25000, readyStock - pricing.netRobux);

    res.status(201).json({
      order,
      storeStatus: {
        readyStock,
        avgProcessMinutes,
        baseRateIdr,
        updatedAt: now.toISOString(),
      },
    });
  });

  app.post('/api/orders/:invoiceId/pay', (req, res) => {
    const invoiceId = String(req.params.invoiceId || '').toUpperCase();
    const order = ordersStore.get(invoiceId);

    if (!order) {
      res.status(404).json({ error: 'Nomor invoice tidak ditemukan.' });
      return;
    }

    const senderName =
      typeof req.body?.senderName === 'string' ? req.body.senderName.trim() : '';

    const updatedOrder: OrderRecord = {
      ...order,
      statusStep: Math.max(1, order.statusStep),
      paymentSenderName: senderName || order.paymentSenderName,
      updatedAt: new Date().toISOString(),
    };

    ordersStore.set(invoiceId, updatedOrder);
    res.json({ order: updatedOrder });
  });

  app.patch('/api/orders/:invoiceId/advance', (req, res) => {
    const invoiceId = String(req.params.invoiceId || '').toUpperCase();
    const order = ordersStore.get(invoiceId);

    if (!order) {
      res.status(404).json({ error: 'Nomor invoice tidak ditemukan.' });
      return;
    }

    if (order.statusStep === 0) {
      res.status(400).json({
        error:
          'Pembayaran belum dikonfirmasi. Selesaikan pembayaran terlebih dahulu sebelum lanjut ke tahap berikutnya.',
      });
      return;
    }

    const requestedStep =
      typeof req.body?.targetStep === 'number' ? req.body.targetStep : order.statusStep + 1;

    const nextStep = Math.max(1, Math.min(4, Math.round(requestedStep)));
    const updatedOrder: OrderRecord = {
      ...order,
      statusStep: nextStep,
      updatedAt: new Date().toISOString(),
    };

    ordersStore.set(invoiceId, updatedOrder);
    res.json({ order: updatedOrder });
  });

  app.post('/api/cs/chat', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error:
          'Kunci API Gemini belum tersedia. Silakan atur GEMINI_API_KEY di panel Settings > Secrets.',
      });
      return;
    }

    const body = req.body as {
      messages?: Array<{ role?: string; text?: string }>;
      context?: CsChatContext;
    };

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const cleanMessages = rawMessages
      .filter(
        (m): m is { role: 'user' | 'assistant'; text: string } =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.text === 'string' &&
          m.text.trim().length > 0
      )
      .slice(-16);

    const lastMessage = cleanMessages[cleanMessages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      res.status(400).json({ error: 'Pesan pengguna tidak boleh kosong.' });
      return;
    }

    // Look up any referenced INV-XXXX order from in-memory ordersStore
    const mentionedInvoices = new Set<string>();
    const invoiceMatches = lastMessage.text.toUpperCase().match(/INV-\d{4}/g);
    if (invoiceMatches) {
      invoiceMatches.forEach((id) => mentionedInvoices.add(id));
    }
    if (body.context?.activeInvoiceId) {
      mentionedInvoices.add(body.context.activeInvoiceId.toUpperCase());
    }

    const matchedOrdersInfo: string[] = [];
    for (const invId of mentionedInvoices) {
      const order = ordersStore.get(invId);
      if (order) {
        const stages = getOrderStages(order.method);
        const stageName = stages[order.statusStep] || stages[0];
        matchedOrdersInfo.push(
          `- ${order.invoiceId}: Username @${order.username}, Metode ${order.method}, Nominal ${formatRobux(
            order.netRobux
          )}, Total ${formatIdr(order.totalIdr)}, Pembayaran ${order.paymentChannelName}, Status Tahap ${
            order.statusStep
          }/4 (${stageName}).`
        );
      } else {
        matchedOrdersInfo.push(`- ${invId}: Tidak ditemukan di sistem pesanan saat ini.`);
      }
    }

    const contextLines: string[] = [];
    if (body.context?.username) {
      contextLines.push(`- Username Roblox terverifikasi di form: @${body.context.username}`);
    }
    if (body.context?.method) {
      contextLines.push(`- Metode yang sedang dipilih: ${body.context.method}`);
    }
    if (typeof body.context?.netRobux === 'number' && body.context.netRobux > 0) {
      contextLines.push(`- Nominal Robux dipilih: ${formatRobux(body.context.netRobux)}`);
    }
    if (body.context?.selectedChannelName) {
      contextLines.push(`- Metode pembayaran dipilih: ${body.context.selectedChannelName}`);
    }

    const systemInstruction = `Kamu adalah **IMO Service**, asisten Customer Service AI resmi dari **IMO STORE** (platform Top-Up Robux Roblox Indonesia).
Gunakan bahasa Indonesia yang ramah, profesional, ringkas, dan langsung membantu (maksimal 3-4 kalimat atau poin singkat agar mudah dibaca di chat widget). Jangan mengarang data di luar informasi toko.

Informasi resmi IMO STORE saat ini:
1. Status Toko Live:
   - Stok Ready: ${formatRobux(readyStock)}
   - Estimasi proses metode instan: ~${avgProcessMinutes} menit

2. Metode Top-Up & Kurs:
   - Via Gamepass (5 Hari): Rp 135 / R$. Aman tanpa login. Pembeli wajib membuat Gamepass dengan harga disesuaikan pajak 30% Roblox (rumus: Math.ceil(Robux bersih / 0.7), contoh 800 R$ bersih -> buat Gamepass 1.143 R$). Robux masuk sebagai Pending 5 Hari dari Roblox.
   - Via Login (Instan): Rp 148 / R$. Proses ~4 menit, menggunakan enkripsi sesi satu kali pakai.
   - Via Username (Instan): Rp 155 / R$. Proses ~4 menit, cukup username Roblox tujuan tanpa perlu password dan tanpa membuat Gamepass.

3. Ketentuan Nominal & Diskon Grosir:
   - Minimal 50 R$, maksimal 20.000 R$.
   - Diskon otomatis: >= 1.000 R$ (3%), >= 5.000 R$ (6%), >= 10.000 R$ (10%).

4. Metode Pembayaran Resmi Saat Ini:
   - GoPay (Prioritas, bebas biaya admin): 081216732996 a/n Reno Malindo
   - SeaBank (Transfer Bank, bebas biaya admin): 901398223365 a/n Reno Malindo
   - QRIS All Payment, DANA, OVO, ShopeePay, BCA, Mandiri, BNI, BRI: saat ini **Sedang Gangguan** sementara. Arahkan pelanggan menggunakan GoPay atau SeaBank.

5. Aturan Pembayaran & Pelacakan:
   - Pembeli wajib melakukan transfer dan menekan tombol **Konfirmasi Sudah Bayar** di modal pembayaran sebelum pesanan dapat diproses atau lanjut ke tahap berikutnya.
   - Pelanggan dapat melacak pesanan lewat tombol **Cek Pesanan** menggunakan nomor invoice (misal INV-8824) atau username Roblox.
${contextLines.length > 0 ? `\nKonteks sesi pembeli saat ini:\n${contextLines.join('\n')}` : ''}
${matchedOrdersInfo.length > 0 ? `\nData pesanan terkait dari sistem:\n${matchedOrdersInfo.join('\n')}` : ''}`;

    const priorHistory = cleanMessages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const modelCandidates: Array<{
      model: string;
      thinkingLevel?: ThinkingLevel;
    }> = [
      { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
      { model: 'gemini-3.1-flash-lite' },
    ];

    let lastError: unknown = null;

    for (const candidate of modelCandidates) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 14000);
      try {
        const contents = cleanMessages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text }],
        }));

        const response = await ai.models.generateContent({
          model: candidate.model,
          contents,
          config: {
            systemInstruction,
            abortSignal: controller.signal,
            ...(candidate.thinkingLevel
              ? {
                  thinkingConfig: {
                    thinkingLevel: candidate.thinkingLevel,
                  },
                }
              : {}),
          },
        });
        clearTimeout(timeoutId);

        const reply = (response.text ?? '').trim();
        if (!reply) {
          throw new Error('Respons kosong dari AI.');
        }

        res.json({ reply });
        return;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err;
        const status =
          typeof (err as { status?: unknown })?.status === 'number'
            ? (err as { status: number }).status
            : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          status === 503 ||
          status === 500 ||
          status === 504 ||
          msg.includes('503') ||
          msg.includes('500') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('aborted') ||
          msg.includes('timeout') ||
          msg.includes('fetch');
        if (isTransient) {
          continue;
        }
        break;
      }
    }

    const errStatus =
      typeof (lastError as { status?: unknown })?.status === 'number'
        ? (lastError as { status: number }).status
        : undefined;
    const errMessage =
      lastError instanceof Error ? lastError.message : 'Gagal menghubungi IMO Service AI.';
    console.error('[IMO Service AI Error]', errStatus, errMessage);

    if (
      errStatus === 403 ||
      errMessage.includes('403') ||
      errMessage.includes('PERMISSION_DENIED') ||
      errMessage.includes('API_KEY_INVALID')
    ) {
      res.status(403).json({
        error:
          'API key Gemini tidak valid atau ditolak. Periksa GEMINI_API_KEY di panel Settings > Secrets.',
      });
      return;
    }

    if (
      errStatus === 429 ||
      errMessage.includes('429') ||
      errMessage.includes('RESOURCE_EXHAUSTED')
    ) {
      res.status(429).json({
        error:
          'Batas kuota permintaan AI sementara tercapai. Silakan coba lagi beberapa saat lagi.',
      });
      return;
    }

    if (errStatus === 404 || errMessage.includes('NOT_FOUND')) {
      res.status(404).json({
        error: 'Model AI yang diminta tidak tersedia saat ini.',
      });
      return;
    }

    res.status(502).json({
      error:
        'IMO Service sedang sibuk atau mengalami gangguan koneksi. Silakan coba kirim ulang.',
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IMO STORE server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
