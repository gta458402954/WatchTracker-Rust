import {
  DndContext,
  closestCenter,
  DragEndEvent,
  SensorDescriptor,
  SensorOptions
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { WatchRecord, Status } from '../../../shared/types';
import RecordCard from './RecordCard';

interface ListViewProps {
  filtered: WatchRecord[];
  sensors: SensorDescriptor<SensorOptions>[];
  onDragEnd: (event: DragEndEvent) => void;
  onEdit: (record: WatchRecord) => void;
  onDelete: (id: string) => void;
  onLockToggle: (id: string) => void;
  onStatusChange: (id: string, status: Status) => void;
  onProgressChange: (id: string, progress: string) => void;
  getEmoji: (category: string) => string;
  canReorder: boolean;
}

export default function ListView({
  filtered,
  sensors,
  onDragEnd,
  onEdit,
  onDelete,
  onLockToggle,
  onStatusChange,
  onProgressChange,
  getEmoji,
  canReorder
}: ListViewProps) {
  const cards = (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {filtered.map(record => (
        <RecordCard
          key={record.id}
          record={record}
          onEdit={onEdit}
          onDelete={onDelete}
          onLockToggle={onLockToggle}
          onStatusChange={onStatusChange}
          onProgressChange={onProgressChange}
          getEmoji={getEmoji}
          isSortable={canReorder}
        />
      ))}
    </div>
  );

  if (!canReorder) return cards;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={filtered.map(r => r.id)}
        strategy={rectSortingStrategy}
      >
        {cards}
      </SortableContext>
    </DndContext>
  );
}