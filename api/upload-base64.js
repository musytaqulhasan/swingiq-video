export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
  const API_KEY    = process.env.CLOUDINARY_API_KEY;
  const API_SECRET = process.env.CLOUDINARY_API_SECRET;

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    return res.status(500).json({ error: 'Cloudinary credentials not configured' });
  }

  try {
    const { base64, filename, mimetype } = req.body;
    if (!base64) return res.status(400).json({ error: 'No base64 data provided' });

    // Always use video/mp4 for Cloudinary — works for .mov too
    const finalMime = 'video/mp4';
    const dataUri = `data:${finalMime};base64,${base64}`;

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
        error: uploadData.error?.message || 'Cloudinary upload failed',
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
    return res.status(500).json({ error: err.message });
  }
}
