/** Client-side Google Drive upload (parity with Node dashboard shared-core). */

const DRIVE_TOKEN_KEY = "erp_drive_token_v1";
const DRIVE_FOLDER_ID_KEY = "erp_drive_folder_id";
const DEFAULT_DRIVE_CLIENT_ID =
  "243860626444-u5749q82a7ue5dtckmqptiu8ov9qjnok.apps.googleusercontent.com";

interface DriveToken {
  access_token: string;
  expires_at: number;
}

function loadToken(): DriveToken | null {
  try {
    return JSON.parse(sessionStorage.getItem(DRIVE_TOKEN_KEY) || "null");
  } catch {
    return null;
  }
}

function saveToken(t: DriveToken) {
  sessionStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify(t));
}

function isValid(t: DriveToken | null): boolean {
  if (!t?.access_token) return false;
  return Date.now() < Number(t.expires_at || 0) - 30_000;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (resp: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => void;
            error_callback?: (err: unknown) => void;
          }) => { requestAccessToken: (opts: { prompt?: string }) => void };
        };
      };
    };
    XLSX?: {
      utils: { json_to_sheet: (rows: unknown[]) => unknown; book_new: () => unknown; book_append_sheet: (wb: unknown, ws: unknown, name: string) => void };
      write: (wb: unknown, opts: { bookType: string; type: string }) => ArrayBuffer;
    };
  }
}

export async function getDriveAccessToken(): Promise<string> {
  const existing = loadToken();
  if (isValid(existing)) return existing!.access_token;

  const gis = window.google?.accounts?.oauth2;
  if (!gis) throw new Error("Google Identity Services failed to load. Please refresh.");

  return new Promise((resolve, reject) => {
    const client = gis.initTokenClient({
      client_id: DEFAULT_DRIVE_CLIENT_ID,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: resp => {
        if (!resp?.access_token) {
          reject(new Error(resp?.error_description || resp?.error || "Google sign-in was cancelled or failed."));
          return;
        }
        saveToken({
          access_token: resp.access_token,
          expires_at: Date.now() + (Number(resp.expires_in || 3600) * 1000),
        });
        resolve(resp.access_token);
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

export async function uploadBlobToDrive(opts: {
  blob: Blob;
  filename: string;
  mimeType: string;
  folderId?: string;
}): Promise<{ id?: string; name?: string; webViewLink?: string }> {
  const accessToken = await getDriveAccessToken();
  const parent = String(opts.folderId || localStorage.getItem(DRIVE_FOLDER_ID_KEY) || "").trim();
  const meta: { name: string; parents?: string[] } = { name: opts.filename };
  if (parent) meta.parents = [parent];

  const boundary = "erp_boundary_xyz987";
  const CRLF = "\r\n";
  const metaStr = JSON.stringify(meta);
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metaStr}${CRLF}`),
    enc.encode(`--${boundary}${CRLF}Content-Type: ${opts.mimeType}${CRLF}${CRLF}`),
    new Uint8Array(await opts.blob.arrayBuffer()),
    enc.encode(`${CRLF}--${boundary}--`),
  ];
  const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.byteLength;
  }

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: { message?: string } }).error?.message || `Drive upload HTTP ${res.status}`);
  return data as { id?: string; name?: string; webViewLink?: string };
}

export function rowsToCsvBlob(rows: Record<string, unknown>[]): Blob {
  if (!rows.length) return new Blob([""], { type: "text/csv" });
  const h = Object.keys(rows[0]);
  const lines = [
    h.join(","),
    ...rows.map(r =>
      h
        .map(k => {
          const v = String(r[k] ?? "").replace(/"/g, '""');
          return v.includes(",") || v.includes("\n") || v.includes('"') ? `"${v}"` : v;
        })
        .join(","),
    ),
  ];
  return new Blob([lines.join("\n")], { type: "text/csv" });
}

export function rowsToXlsxBlob(rows: Record<string, unknown>[], sheetName: string): Blob {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error("Excel library not loaded — please refresh");
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName || "Data").slice(0, 31));
  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
