import { IncomingForm } from 'formidable';
import { readFileSync } from 'fs';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
  const API_KEY = process.env.CLOUDINARY_API_KEY;
  const API_SECRET = process.env.CLOUDINARY_API_SECRET;

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    return res.status(500).json({ error: 'Cloudinary credentials not configured' });
  }

  try {
    const form = new IncomingForm({
      maxFileSize: 100 * 1024 * 1024,
      keepExtensions: true,
    });
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.video) ? files.video[0] : files.video;
    if (!file) return res.status(400).json({ error: 'No video file received' });

    // iOS Safari sends .mov as video/quicktime — treat it like video/mp4 for Cloudinary
    const mimeType = file.mimetype || 'video/mp4';
    const isQuicktime = mimeType === 'video/quicktime' || (file.originalFilename || file.newFilename || '').toLowerCase().endsWith('.mov');

    // Read file and convert to base64
    const fileBuffer = readFileSync(file.filepath);
    const base64Data = fileBuffer.toString('base64');
    const finalMime = isQuicktime ? 'video/mp4' : (file.mimetype || 'video/mp4');
    const dataUri = `data:${finalMime};base64,${base64Data}`;

    // Use Basic auth (signed upload without preset)
    const timestamp = Math.floor(Date.now() / 1000);
    const { createHash } = await import('crypto');
    const signature = createHash('sha256')
      .update(`timestamp=${timestamp}${API_SECRET}`)
      .digest('hex');

    const body = new URLSearchParams();
    body.append('file', dataUri);
    body.append('api_key', API_KEY);
    body.append('timestamp', String(timestamp));
    body.append('signature', signature);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }
    );

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) {
      return res.status(500).json({
        error: uploadData.error?.message || 'Upload failed',
        cloudinary_response: uploadData
      });
    }

    return res.status(200).json({
      url: uploadData.secure_url,
      public_id: uploadData.public_id,
      duration: uploadData.duration,
      width: uploadData.width,
      height: uploadData.height,
      format: uploadData.format,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
