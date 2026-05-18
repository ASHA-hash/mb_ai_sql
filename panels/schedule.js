/* ═══════════════════════════════════════════════
   SCHEDULE PANEL
═══════════════════════════════════════════════ */
function SchedulePanel() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">⏱ Schedule & Auto-Refresh</h2>
        <p className="text-sm text-slate-500 mt-0.5">Automated refreshes via the Google Sheets add-on.</p>
      </div>
      <div className="card p-5" style={{borderLeft:'4px solid #f59e0b'}}>
        <p className="font-semibold text-slate-700 mb-3">ℹ How scheduling works</p>
        <div className="space-y-2 text-sm text-slate-600">
          <div className="flex items-start gap-2"><span className="text-indigo-500 font-bold">1.</span><span>Open the Google Sheet → Extensions → ERP Connector → Open panel</span></div>
          <div className="flex items-start gap-2"><span className="text-indigo-500 font-bold">2.</span><span>Go to the <strong>Schedule</strong> tab inside the sidebar</span></div>
          <div className="flex items-start gap-2"><span className="text-indigo-500 font-bold">3.</span><span>Choose an interval: Hourly / Every 6 hrs / Every 12 hrs / Daily</span></div>
          <div className="flex items-start gap-2"><span className="text-indigo-500 font-bold">4.</span><span>Click <strong>Enable schedule</strong> — a time trigger runs under your Google account</span></div>
          <div className="flex items-start gap-2"><span className="text-indigo-500 font-bold">5.</span><span>Optionally set an alert email or Google Chat webhook</span></div>
        </div>
      </div>
      <div className="card p-5">
        <p className="font-semibold text-slate-700 mb-1.5">Server-side scheduled refresh <span className="badge bg-amber-100 text-amber-700 ml-2">Coming soon</span></p>
        <p className="text-slate-500 text-sm">A future version will support server-side cron jobs so you don't need Google Sheets open. The API server can push refreshed data directly to your spreadsheet.</p>
        <div className="mt-3 inline-flex items-center gap-2 bg-slate-50 rounded-xl px-3 py-2 text-xs text-slate-500 border border-slate-200">
          <span>API endpoint:</span>
          <code className="font-mono text-indigo-600">GET /api/dataset/:key</code>
        </div>
      </div>
    </div>
  );
}
