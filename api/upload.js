import { IncomingForm } from 'formidable';
import { createReadStream } from 'fs';
import FormData from 'form-data';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
  if (!CLOUD_NAME) return res.status(500).json({ error: 'CLOUDINARY_CLOUD_NAME not configured' });

  try {
    const form = new IncomingForm({ maxFileSize: 100 * 1024 * 1024 });
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.video) ? files.video[0] : files.video;
    if (!file) return res.status(400).json({ error: 'No video file received' });

    // Unsigned upload — uses upload preset, no signature needed
    const form2 = new FormData();
    form2.append('file', createReadStream(file.filepath), {
      filename: file.originalFilename || 'video.mp4',
      contentType: file.mimetype || 'video/mp4',
    });
    form2.append('upload_preset', 'swingiq_videos');
    form2.append('folder', 'swingiq');

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`,
      { method: 'POST', body: form2, headers: form2.getHeaders() }
    );

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) return res.status(500).json({ error: uploadData.error?.message || 'Upload failed' });

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
