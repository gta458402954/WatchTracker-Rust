
interface HeaderProps {
  searchText: string;
  onSearchChange: (value: string) => void;
  sortBy: 'createdAt' | 'endDate' | 'rating' | 'releaseYear' | 'watchValue';
  onSortByChange: (value: 'createdAt' | 'endDate' | 'rating' | 'releaseYear' | 'watchValue') => void;
  lockFilter: 'all' | 'locked' | 'unlocked';
  onLockFilterChange: (value: 'all' | 'locked' | 'unlocked') => void;
  hasWebDAVCreds: boolean;
  syncing: boolean;
  syncMsg: string;
  onQuickSync: () => void;
  isSyncPaused: boolean;
  syncPending: boolean;
  onToggleSyncPause: () => void;
  viewMode: 'list' | 'poster';
  onViewModeChange: (value: 'list' | 'poster') => void;
  onShowDashboard: () => void;
  onShowSettings: () => void;
  onShowForm: () => void;
}

export default function Header({
  searchText,
  onSearchChange,
  sortBy,
  onSortByChange,
  lockFilter,
  onLockFilterChange,
  hasWebDAVCreds,
  syncing,
  syncMsg,
  onQuickSync,
  isSyncPaused,
  syncPending,
  onToggleSyncPause,
  viewMode,
  onViewModeChange,
  onShowDashboard,
  onShowSettings,
  onShowForm
}: HeaderProps) {
  const gitCommit = import.meta.env.VITE_GIT_COMMIT || 'unknown';

  return (
    <header className="bg-white border-b border-gray-100 sticky top-0 z-40 shadow-sm">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
        {/* Title */}
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎬</span>
          <span
            data-testid="build-commit"
            title={`Git 提交 ${gitCommit}`}
            className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500"
          >
            git {gitCommit}
          </span>
          <h1 className="text-lg font-bold text-gray-900 hidden sm:block">影视追踪</h1>
        </div>

        {/* Search */}
        <div className="flex-1 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="搜索电影、剧集..."
            value={searchText}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-3 h-9 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition bg-gray-50"
          />
        </div>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={e => onSortByChange(e.target.value as typeof sortBy)}
          className="h-9 text-sm px-3 rounded-xl border border-gray-200 outline-none bg-white text-gray-600 cursor-pointer focus:border-indigo-400"
        >
          <option value="createdAt">最新添加</option>
          <option value="endDate">完成时间</option>
          <option value="releaseYear">上映年份</option>
          <option value="rating">评分</option>
          <option value="watchValue">待看价值</option>
        </select>

        {/* Hide watched toggle */}
        <button
          onClick={() => onLockFilterChange(lockFilter === 'all' ? 'locked' : lockFilter === 'locked' ? 'unlocked' : 'all')}
          title={lockFilter === 'locked' ? '仅显示已锁定' : lockFilter === 'unlocked' ? '仅显示未锁定' : '显示全部'}
          className={`h-9 px-3 flex items-center gap-1.5 rounded-xl border text-sm transition-colors ${
            lockFilter !== 'all'
              ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
              : 'border-gray-200 text-gray-500 hover:bg-gray-50'
          }`}
        >
          {lockFilter === 'locked' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : lockFilter === 'unlocked' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
          <span className="hidden sm:inline">{lockFilter === 'locked' ? '已锁定' : lockFilter === 'unlocked' ? '未锁定' : '全部'}</span>
        </button>

        {/* Sync Button */}
        {hasWebDAVCreds && (
          <div className="relative">
            <button
              onClick={onQuickSync}
              disabled={syncing}
              title="手动同步到坚果云"
              className="h-9 px-3 flex items-center gap-1.5 rounded-xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-50"
            >
              {syncing ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h10a4 4 0 001.8-7.6A7 7 0 005.1 10.4 4 4 0 003 15z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11v6m-3-3l3-3 3 3" />
                </svg>
              )}
            </button>
            {syncMsg && (
              <div className="absolute top-11 right-0 z-50 whitespace-nowrap bg-gray-800 text-white text-xs px-2.5 py-1.5 rounded-lg shadow-lg">
                {syncMsg}
              </div>
            )}
          </div>
        )}

        {/* Sync Pause Toggle */}
        {hasWebDAVCreds && (
          <button
            onClick={onToggleSyncPause}
            title={isSyncPaused ? '已暂停自动同步，待同步修改会保留' : syncPending ? '有本地修改等待自动同步' : '自动同步已开启'}
            className={`h-9 px-3 flex items-center gap-1.5 rounded-xl border transition-colors ${
              isSyncPaused 
                ? 'bg-amber-50 border-amber-200 text-amber-600' 
                : 'bg-green-50 border-green-200 text-green-600'
            }`}
          >
            {isSyncPaused ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v4m4-4v4m-9-4h18c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6c0-1.1.9-2 2-2z" /></svg>
                <span className="text-xs font-bold hidden md:block">已暂停</span>
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs font-bold hidden md:block">{syncPending ? '待同步' : '自动同步'}</span>
              </>
            )}
          </button>
        )}

        {/* View Mode Toggle */}
        <button
          onClick={() => onViewModeChange(viewMode === 'list' ? 'poster' : 'list')}
          title={viewMode === 'list' ? '切换至海报墙' : '切换至列表'}
          className={`h-9 px-3 flex items-center gap-1.5 rounded-xl border transition-colors ${
            viewMode === 'poster'
              ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
              : 'border-gray-200 text-gray-500 hover:bg-gray-50'
          }`}
        >
          {viewMode === 'list' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          )}
        </button>

        {/* Dashboard */}
        <button
          onClick={onShowDashboard}
          className="h-9 px-3 flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600 text-sm hover:bg-indigo-100 hover:text-indigo-700 transition-colors font-medium"
          title="数据看板"
        >
          <span className="text-base">📈</span>
          <span className="hidden sm:inline">看板</span>
        </button>

        {/* Settings */}
        <button
          onClick={onShowSettings}
          aria-label="设置"
          title="设置"
          className="h-9 px-3 flex items-center gap-1.5 rounded-xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 hover:text-gray-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* Add Button */}
        <button
          onClick={onShowForm}
          className="flex items-center gap-1.5 px-4 h-9 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span className="hidden sm:inline">添加</span>
        </button>
      </div>
    </header>
  );
}
