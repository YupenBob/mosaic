/**
 * Generate a post with many photos to stress test the gallery + filmstrip.
 * Usage: node scripts/generate-stress-test.js [count]
 * Default: 150 photos
 */
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
  '#3498db', '#9b59b6', '#e91e63', '#00bcd4', '#ff5722',
  '#3f51b5', '#4caf50', '#ff9800', '#795548', '#607d8b',
  '#8bc34a', '#03a9f4', '#ffc107', '#009688', '#673ab7',
];

async function run() {
  const count = parseInt(process.argv[2]) || 150;
  const postDir = path.resolve(import.meta.dirname, '..', 'content', 'posts', 'stress-test');
  const photosDir = path.join(postDir, 'photos');
  await fs.ensureDir(photosDir);

  console.log(`Generating ${count} placeholder photos...`);

  for (let i = 1; i <= count; i++) {
    const color = COLORS[(i - 1) % COLORS.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
      <rect width="1920" height="1080" fill="${color}"/>
      <text x="50%" y="45%" text-anchor="middle" font-family="sans-serif"
            font-size="120" fill="rgba(255,255,255,0.6)" font-weight="bold">Photo ${i}</text>
      <text x="50%" y="58%" text-anchor="middle" font-family="sans-serif"
            font-size="40" fill="rgba(255,255,255,0.3)">${color}</text>
    </svg>`;
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 60 }).toBuffer();
    const fname = `img-${String(i).padStart(4, '0')}.jpg`;
    await fs.writeFile(path.join(photosDir, fname), buf);
    if (i % 50 === 0) console.log(`  ${i}/${count}`);
  }

  // Cover
  const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <rect width="1920" height="1080" fill="#1a1a2e"/>
    <text x="50%" y="50%" text-anchor="middle" font-family="sans-serif"
          font-size="80" fill="rgba(255,255,255,0.5)" font-weight="bold">Gallery Stress Test - ${count} Photos</text>
  </svg>`;
  await fs.writeFile(path.join(postDir, 'cover.jpg'), await sharp(Buffer.from(coverSvg)).jpeg({ quality: 80 }).toBuffer());

  // Index.md
  const md = `---
title: "Gallery Stress Test (${count} Photos)"
date: 2026-05-01
category: test
tags: [stress-test, gallery]
description: "A post with ${count} photos to test gallery performance and filmstrip."
cover: cover.jpg
layout: gallery-first
views: 100
likes: 5
dwell_time: 60
---

## Stress Test

This post contains ${count} photos. Use it to test:

- Gallery grid lazy loading
- Fullscreen viewer performance
- Filmstrip navigation
- Quality switching
- Memory usage with many images

Open any photo to enter fullscreen mode. Use the bottom filmstrip to navigate quickly.
`;
  await fs.writeFile(path.join(postDir, 'index.md'), md);

  console.log('Done. Post created at content/posts/stress-test/');
}

run().catch(console.error);
