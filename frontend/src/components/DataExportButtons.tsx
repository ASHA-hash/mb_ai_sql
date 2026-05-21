import { useState } from "react";
import { downloadBlob, rowsToCsvBlob, rowsToXlsxBlob, uploadBlobToDrive } from "../lib/googleDrive";

export default function DataExportButtons({
  rows,
  datasetKey,
}: {
  rows: Record<string, unknown>[];
  datasetKey: string;
}) {
  const [saving, setSaving] = useState<"csv" | "xlsx" | null>(null);

  async function saveDrive(kind: "csv" | "xlsx") {
    if (!rows.length || saving) return;
    setSaving(kind);
    try {
      const filename = kind === "csv" ? `${datasetKey}.csv` : `${datasetKey}.xlsx`;
      const blob =
        kind === "csv"
          ? rowsToCsvBlob(rows)
          : rowsToXlsxBlob(rows, datasetKey);
      const out = await uploadBlobToDrive({
        blob,
        filename,
        mimeType: kind === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const link = out.webViewLink ? `\n\n🔗 Open in Drive:\n${out.webViewLink}` : "";
      alert(`✅ Saved to YOUR Google Drive!\nFile: ${out.name || filename}${link}`);
    } catch (e) {
      alert("❌ Drive error:\n" + String((e as Error).message || e));
    } finally {
      setSaving(null);
    }
  }

  function exportLocal(kind: "csv" | "xlsx") {
    if (!rows.length) return;
    try {
      if (kind === "csv") {
        downloadBlob(rowsToCsvBlob(rows), `${datasetKey}.csv`);
      } else {
        downloadBlob(rowsToXlsxBlob(rows, datasetKey), `${datasetKey}.xlsx`);
      }
    } catch (e) {
      alert(String((e as Error).message || e));
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        className="btn-ghost text-xs px-3 py-1.5"
        disabled={!rows.length || !!saving}
        onClick={() => saveDrive("csv")}
        title="Save CSV to your Google Drive"
      >
        {saving === "csv" ? "Saving…" : "☁ Drive CSV"}
      </button>
      <button
        type="button"
        className="btn-ghost text-xs px-3 py-1.5"
        disabled={!rows.length || !!saving}
        onClick={() => saveDrive("xlsx")}
        title="Save Excel to your Google Drive"
      >
        {saving === "xlsx" ? "Saving…" : "☁ My Drive Excel"}
      </button>
      <button type="button" className="btn-ghost text-xs px-3 py-1.5" disabled={!rows.length} onClick={() => exportLocal("xlsx")}>
        ⬇ Excel
      </button>
      <button type="button" className="btn-ghost text-xs px-3 py-1.5" disabled={!rows.length} onClick={() => exportLocal("csv")}>
        ⬇ CSV
      </button>
    </div>
  );
}
