import { Redis } from '@upstash/redis';
import { put } from '@vercel/blob';
import { createHash } from 'node:crypto';

const redis = Redis.fromEnv();
const KEY = 'techauto:site';
const STATUSES = ['stock', 'order', 'sold'];
const sha = (p) => createHash('sha256').update('techauto:' + p).digest('hex');

async function load() {
  const s = await redis.get(KEY);
  return s && typeof s === 'object' ? s : { wa: '996556150245', items: {} };
}

async function checkPin(req, site, pin) {
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const fk = 'techauto:fail:' + ip;
  const fails = Number((await redis.get(fk)) || 0);
  if (fails >= 5) return 429;
  const expected = site.pinHash || sha(process.env.OWNER_PIN || '1234');
  if (typeof pin === 'string' && sha(pin) === expected) {
    if (fails) await redis.del(fk);
    return 200;
  }
  await redis.incr(fk);
  await redis.expire(fk, 60);
  return 401;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const site = await load();
    if (req.method === 'GET') {
      return res.status(200).json({ wa: site.wa, items: site.items || {} });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const b = req.body || {};
    const code = await checkPin(req, site, b.pin);
    if (code !== 200) return res.status(code).json({ error: code === 429 ? 'locked' : 'pin' });

    if (b.action === 'auth') return res.status(200).json({ ok: true });

    if (b.action === 'save') {
      const wa = String(b.wa || '').replace(/\D/g, '');
      if (wa.length < 11 || wa.length > 15) return res.status(400).json({ error: 'wa' });
      const items = {};
      for (const [id, o] of Object.entries(b.items || {})) {
        if (!/^IMG_\d{1,6}$/.test(id) || !o) continue;
        const price = Math.round(Number(o.price));
        const photo = typeof o.photo === 'string' && /^(https:\/\/|\/img\/)/.test(o.photo) && o.photo.length < 600 ? o.photo : '';
        items[id] = {
          price: Number.isFinite(price) && price > 0 && price < 1e10 ? price : 0,
          status: STATUSES.includes(o.status) ? o.status : 'order',
          photo,
        };
      }
      await redis.set(KEY, { ...site, wa, items });
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'setpin') {
      if (!/^\d{4}$/.test(String(b.newPin || ''))) return res.status(400).json({ error: 'newpin' });
      await redis.set(KEY, { ...site, pinHash: sha(String(b.newPin)) });
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'upload') {
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(b.data || ''));
      if (!m) return res.status(400).json({ error: 'image' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 3.5 * 1024 * 1024) return res.status(413).json({ error: 'size' });
      const blob = await put(`techauto/${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, buf, {
        access: 'public',
        contentType: 'image/' + m[1],
      });
      return res.status(200).json({ url: blob.url });
    }

    return res.status(400).json({ error: 'action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
}
