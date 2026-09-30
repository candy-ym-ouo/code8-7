export type BookStatus = 'TO_READ' | 'READING' | 'READ' | 'PAUSED' | 'ABANDONED';
export type MoodTag = 'MOVED' | 'CALM' | 'JOYFUL' | 'SAD' | 'ANGRY' | 'CONFUSED' | 'RELIEVED' | 'EMPTY' | 'CHANGED';
export type TraceType = 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK';
export type ActivityAction =
  | 'CREATED'
  | 'UPDATED'
  | 'DELETED'
  | 'RESTORED'
  | 'STATUS_CHANGED'
  | 'COMPLETED'
  | 'REVISION_RESTORED';
export type ActivityEntityType = 'BOOK' | 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK' | 'COMPLETION_REFLECTION';
export type RevisionAction = 'INITIAL' | 'UPDATED' | 'DELETED' | 'RESTORED' | 'VERSION_RESTORED';
export declare const BOOK_STATUSES: BookStatus[];
export declare const MOOD_TAGS: MoodTag[];
export declare const TRACE_TYPES: TraceType[];
export declare const ACTIVITY_ACTIONS: ActivityAction[];
export declare const ACTIVITY_ENTITY_TYPES: ActivityEntityType[];
export declare const REVISION_ACTIONS: RevisionAction[];
