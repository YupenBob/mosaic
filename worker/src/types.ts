// ──────────────────────────────────────────────
// Mosaic v0.8 — Worker API Type Definitions
// ──────────────────────────────────────────────

// ── Auth ────────────────────────────────────
export interface AuthPayload {
  sub: string;          // "admin"
  iat: number;          // issued at
  exp: number;          // expiration
}

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
}

// ── Upload ──────────────────────────────────
export interface UploadInitRequest {
  slug: string;
  files: {
    name: string;
    type: 'photo' | 'video' | 'music' | 'cover';
    contentType: string;
    size: number;
  }[];
}

export interface UploadInitResponse {
  uploadId: string;
  files: {
    name: string;
    presignedUrl: string;
    key: string;           // R2 object key
  }[];
}

export interface UploadCompleteRequest {
  uploadId: string;
}

export interface UploadStatus {
  id: string;
  slug: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  files: { name: string; uploaded: boolean }[];
  createdAt: string;
}

// ── Build ───────────────────────────────────
export interface BuildStatus {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  conclusion: 'success' | 'failure' | 'cancelled' | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface BuildHistoryItem {
  id: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

// ── Media ───────────────────────────────────
export interface MediaListResponse {
  slug: string;
  photos: MediaFile[];
  videos: MediaFile[];
  music: MediaFile[];
  covers: MediaFile[];
}

export interface MediaFile {
  name: string;
  size: number;
  lastModified: string;
  url: string;
  processed?: boolean;
}

// ── Stats ───────────────────────────────────
export interface DashboardStats {
  posts: number;
  categories: number;
  tags: number;
  lastBuild: string | null;
  diskUsage: {
    originals: number;     // bytes
    processed: number;
    total: number;
  };
}

// ── Config ──────────────────────────────────
export interface SiteConfig {
  title: string;
  subtitle: string;
  description: string;
  url: string;
  language: string;
  author: { name: string; email: string };
  dateFormat: string;
  pageSize: number;
  gallerySingleThreshold: number;
  favicon: string;
  coverAspectMin: number;
  coverAspectMax: number;
  theme: string;
  themeOverrides?: Record<string, unknown>;
  headerNav: { label: string; url: string }[];
  footerText: string;
  searchMinChars: number;
  imageQuality: Record<string, number>;
  videoQuality: { crf: number; preset: string };
  musicQuality: { mp3_320k: { bitrate: string }; mp3_128k: { bitrate: string } };
  cardShowTags: boolean;
  cardShowStats: boolean;
  enableBusuanzi: boolean;
  enableVideoCompression: boolean;
  mediaSource: {
    type: string;
    bucket: string;
    endpoint: string;
  };
  plugins: Record<string, { enabled: boolean }>;
  components: Record<string, Record<string, unknown>>;
  giscus: {
    repo: string;
    repoId: string;
    category: string;
    categoryId: string;
  };
}

// ── Env ─────────────────────────────────────
export interface Env {
  MEDIA: R2Bucket;
  AUTH: KVNamespace;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  JWT_SECRET: string;
  ADMIN_PASSWORD_HASH: string;
  R2_PUBLIC_URL: string;
  SITE_URL: string;
}
