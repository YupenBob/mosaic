/**
 * Generates placeholder images and cover for demo posts using sharp.
 * Run: node scripts/generate-demo.js
 */
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';

const COLORS = [
  { bg: '#3a7bd5', fg: '#6fa8dc' },
  { bg: '#e74c3c', fg: '#f1948a' },
  { bg: '#2ecc71', fg: '#82e0aa' },
  { bg: '#f39c12', fg: '#f8c471' },
  { bg: '#9b59b6', fg: '#c39bd3' },
  { bg: '#1abc9c', fg: '#76d7c4' },
  { bg: '#e67e22', fg: '#f0b27a' },
  { bg: '#3498db', fg: '#85c1e9' },
  { bg: '#e91e63', fg: '#f06292' },
  { bg: '#00bcd4', fg: '#4dd0e1' },
  { bg: '#8bc34a', fg: '#aed581' },
  { bg: '#ff5722', fg: '#ff8a65' },
];

async function createGradientImage(width, height, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:${color.bg}"/>
        <stop offset="100%" style="stop-color:${color.fg}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>
    <text x="50%" y="50%" text-anchor="middle" dy=".3em"
          font-family="sans-serif" font-size="${Math.floor(Math.min(width, height) / 6)}"
          fill="rgba(255,255,255,0.5)" font-weight="bold">Photo</text>
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function generateDemoContent() {
  const contentDir = path.resolve(import.meta.dirname, '..', 'content', 'posts');

  const posts = [
    {
      slug: 'coastal-sunset',
      photoCount: 12,
    },
    {
      slug: 'winter-macro',
      photoCount: 8,
    },
  ];

  for (const post of posts) {
    const postDir = path.join(contentDir, post.slug);
    const photosDir = path.join(postDir, 'photos');
    const videosDir = path.join(postDir, 'videos');

    await fs.ensureDir(photosDir);
    await fs.ensureDir(videosDir);

    console.log(`Generating demo content for: ${post.slug}`);

    // Generate cover
    const cover = await createGradientImage(1920, 1080, COLORS[0]);
    await fs.writeFile(path.join(postDir, 'cover.jpg'), cover);

    // Generate photos
    for (let i = 1; i <= post.photoCount; i++) {
      const color = COLORS[(i - 1) % COLORS.length];
      const photo = await createGradientImage(1920, 1080, color);
      const fname = `img-${String(i).padStart(3, '0')}.jpg`;
      await fs.writeFile(path.join(photosDir, fname), photo);
    }

    console.log(`  ${post.photoCount} photos + cover generated`);
  }

  console.log('Demo content generation complete.');
}

generateDemoContent().catch(console.error);
