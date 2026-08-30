interface ImportExportPanelProps { exporting?: boolean; status?: string; onImportLocal: () => void; onExport: () => void; }
export default function ImportExportPanel({ exporting = false, status = '', onImportLocal, onExport }: ImportExportPanelProps) {
  return <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">📁</span>
                  <div>
                    <h4 className="font-bold text-gray-800">本地文件导入与导出</h4>
                    <p className="text-[11px] text-gray-400">选择保存位置，导出或读取包含记录、逐集历史和收藏集的完整 JSON 备份</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={onImportLocal}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-600 transition-colors shadow-sm"
                  >
                    📤 导入本地 JSON
                  </button>
                  <button
                    onClick={() => void onExport()}
                    disabled={exporting}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-600 transition-colors shadow-sm disabled:cursor-wait disabled:opacity-60"
                  >
                    {exporting ? '⏳ 正在导出…' : '📥 导出备份 JSON'}
                  </button>
                </div>
                {status && <p role="status" className="break-all rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-600">{status}</p>}
</div>;
}
