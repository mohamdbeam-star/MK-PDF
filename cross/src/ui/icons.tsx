import {
  MousePointer2, Hand, TextCursorInput, Highlighter, Underline, Strikethrough, StickyNote, Type, PenLine, Square, Circle, Minus, MoveUpRight,
  Eraser, Stamp, Check, X, Dot, Calendar, RectangleHorizontal, Link, Crop, EyeOff, TextCursor, SquareCheck, ChevronDown, FilePen,
  MessageSquare, Signature, LayoutGrid, ClipboardList, Lock, ScanText, Shrink, Share, Ellipsis, FolderOpen, FilePlus, Files, Images, GitCompare,
  Undo2, Redo2, Save, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, PanelLeft, PanelRight, Search, Bookmark, Trash2, RotateCw, RotateCcw, Copy,
  Scissors, ArrowUpDown, Plus, Download, Printer, Info, Camera, Moon, Sun, Image, ImageMinus, ImagePlus, FileOutput, Droplet, Hash, Heading,
  RefreshCw, Bandage, Layers, Menu, Upload, Volume2, BookOpen, Replace, Pencil, Contrast, Boxes, Columns2, FileType,
} from 'lucide-preact';

const MAP = {
  cursor: MousePointer2, hand: Hand, textcursor: TextCursorInput, highlighter: Highlighter, underline: Underline, strike: Strikethrough,
  note: StickyNote, textbox: Type, pen: PenLine, square: Square, circle: Circle, line: Minus, arrow: MoveUpRight, eraser: Eraser, stamp: Stamp,
  check: Check, x: X, dot: Dot, calendar: Calendar, whiteout: RectangleHorizontal, link: Link, crop: Crop, eyeoff: EyeOff, field: TextCursor,
  checkbox: SquareCheck, dropdown: ChevronDown, edit: FilePen, comment: MessageSquare, sign: Signature, grid: LayoutGrid, form: ClipboardList,
  lock: Lock, scan: ScanText, compress: Shrink, export: Share, more: Ellipsis, open: FolderOpen, new: FilePlus, combine: Files, images: Images,
  compare: GitCompare, undo: Undo2, redo: Redo2, save: Save, zoomin: ZoomIn, zoomout: ZoomOut, prev: ChevronLeft, next: ChevronRight,
  sidebar: PanelLeft, panel: PanelRight, search: Search, bookmark: Bookmark, trash: Trash2, rotcw: RotateCw, rotccw: RotateCcw, copy: Copy,
  scissors: Scissors, reverse: ArrowUpDown, plus: Plus, download: Download, print: Printer, info: Info, camera: Camera, moon: Moon, sun: Sun,
  image: Image, imageminus: ImageMinus, imageplus: ImagePlus, output: FileOutput, droplet: Droplet, hash: Hash, heading: Heading, refresh: RefreshCw,
  repair: Bandage, layers: Layers, menu: Menu, share: Upload, speak: Volume2, read: BookOpen, replace: Replace, rename: Pencil,
  gray: Contrast, batch: Boxes, columns: Columns2, filetype: FileType,
} as const;

export type IconName = keyof typeof MAP;

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const C = MAP[name as IconName] ?? Ellipsis;
  return <C size={size} strokeWidth={1.8} aria-hidden="true" />;
}
