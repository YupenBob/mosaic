# Migrating from Mosaic v0.7 to v0.8

## Overview

Mosaic v0.8 introduces a cloud-native architecture. The main changes are:
- Media files move from Git to Cloudflare R2
- Build happens in GitHub Actions instead of locally
- Admin panel becomes cloud-hosted (no more local Express server)
- New music/media type support

## Migration Steps

### 1. Run the migration scanner

```bash
node scripts/migrate-v0.8.js
```

This will:
- Inventory all your media files (photos, videos, covers)
- Show total size and count per post
- Update `mosaic.config.json` with new v0.8 fields
- Set up `themes/default/` directory

### 2. Set up Cloudflare R2

1. Create a Cloudflare account at https://dash.cloudflare.com
2. Navigate to R2 → Create bucket
3. Name: `mosaic-media`
4. Create an API token with R2 Read/Write access
5. Note your Account ID, Access Key, Secret Key
6. Set a custom domain (e.g., `media.yourdomain.com`) for public access

### 3. Upload media to R2

```bash
# Install rclone: https://rclone.org/install/
# Configure rclone with your R2 credentials (see rclone.conf.example)

# Upload all media files
rclone copy content/posts/ r2:mosaic-media/originals/ \
  --include "photos/**" \
  --include "videos/**" \
  --include "music/**" \
  --include "cover.*" \
  --transfers 4 \
  --verbose

# Verify the upload
rclone check content/posts/ r2:mosaic-media/originals/ \
  --include "photos/**" --include "videos/**" --include "cover.*"
```

### 4. Clean local media (optional)

Once you've verified the R2 upload, you can remove local media files:

```bash
node scripts/migrate-v0.8.js --clean-media
```

This deletes photos/, videos/, and cover files from content/, keeping only index.md.

### 5. Configure GitHub Secrets

Add these to your repository (Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `R2_ACCESS_KEY` | Your R2 access key |
| `R2_SECRET_KEY` | Your R2 secret key |
| `R2_ENDPOINT` | `https://{account_id}.r2.cloudflarestorage.com` |
| `R2_PUBLIC_URL` | `https://media.yourdomain.com` |
| `CLOUDFLARE_API_TOKEN` | CF API token with Pages edit |
| `CLOUDFLARE_ACCOUNT_ID` | Your CF account ID |
| `ADMIN_PASSWORD_HASH` | SHA-256 hash of your admin password |

### 6. Update GitHub Actions

Replace `.github/workflows/deploy.yml` with the new `.github/workflows/build.yml`.

### 7. Deploy the Worker

```bash
cd worker
npm install
wrangler deploy
```

Set Worker secrets:
```bash
wrangler secret put JWT_SECRET
wrangler secret put ADMIN_PASSWORD_HASH
wrangler secret put GITHUB_TOKEN
```

### 8. Deploy Cloud Admin

```bash
cd cloud-admin
wrangler pages deploy ./
```

Update `API_BASE` in `cloud-admin/index.html` to point to your Worker URL.

### 9. Test the build

Push a change to `main` branch. GitHub Actions will:
1. Sync media from R2
2. Process images/videos/music
3. Generate the static site
4. Deploy to Cloudflare Pages

Or trigger a build from Cloud Admin → Build → Build & Deploy.

### 10. Verify

- [ ] Site loads at your Pages URL
- [ ] Images display correctly (R2 URLs in src)
- [ ] Videos play (HLS streaming)
- [ ] Music player works
- [ ] Search works
- [ ] RSS feed is accessible
- [ ] Cloud Admin login works
- [ ] Upload via Cloud Admin works

## Backward Compatibility

v0.8 build scripts are backward-compatible with v0.7 project structure:
- If R2 is not configured, media files are read from local paths
- New config fields have sensible defaults
- You can gradually migrate — start with R2, then add cloud features

## Troubleshooting

### Media not showing
- Check `R2_PUBLIC_URL` is correct
- Verify media was uploaded to `processed/{slug}/` in R2
- Check CORS settings on R2 custom domain

### Build fails
- Check GitHub Actions logs for rclone errors
- Verify R2 credentials are correct
- Ensure FFmpeg is available in the Action runner

### Cloud Admin can't connect
- Verify Worker is deployed and running
- Check `API_BASE` URL in Cloud Admin
- Ensure CORS is configured on the Worker
