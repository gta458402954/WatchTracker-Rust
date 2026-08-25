import { WatchRecord, Status, type WatchCollection } from '../../../shared/types';
import RecordCard from './RecordCard';

interface ListViewProps {
  filtered: WatchRecord[];
  onEdit: (record: WatchRecord) => void;
  onDelete: (id: string) => void;
  onLockToggle: (id: string) => void;
  onStatusChange: (id: string, status: Status) => void;
  onNextEpisodeChange: (record: WatchRecord, nextEpisode: number | null) => void;
  collectionLinksByRecord?: Map<string, Array<Pick<WatchCollection, 'id' | 'name'>>>;
  onOpenCollection: (collectionId: string) => void;
}

export default function ListView({ filtered, onEdit, onDelete, onLockToggle, onStatusChange, onNextEpisodeChange, collectionLinksByRecord, onOpenCollection }: ListViewProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {filtered.map(record => (
        <RecordCard key={record.id} record={record} collectionLinks={collectionLinksByRecord?.get(record.id)} onOpenCollection={onOpenCollection} onEdit={onEdit} onDelete={onDelete} onLockToggle={onLockToggle} onStatusChange={onStatusChange} onNextEpisodeChange={onNextEpisodeChange} />
      ))}
    </div>
  );
}
