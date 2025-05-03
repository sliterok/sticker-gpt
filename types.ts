export enum TaskStatus {
  queued = "queued",
  succeeded = "succeeded",
  running = "running",
}

export enum TaskType {
  imageGen = "image_gen",
  videoGen = "video_gen",
}

export interface IResponse {
  data: IDaum[];
  last_id: string;
  has_more: boolean;
}

export interface IDaum {
  ordering_key: number;
  payload: IPayload;
}

export interface IPayload {
  id: string;
  user: string;
  created_at: string;
  status: TaskStatus;
  progress_pct: number;
  progress_pos_in_queue: any;
  estimated_queue_wait_time: any;
  queue_status_message: any;
  priority: number;
  type: TaskType;
  prompt: any;
  actions: IActions;
  n_variants: number;
  n_frames: number;
  height: number;
  width: number;
  seed: any;
  guidance: any;
  inpaint_items: IInpaintItem[];
  interpolation: any;
  sdedit: any;
  model: string;
  operation: string;
  preset_id: any;
  remix_config: any;
  generations?: IGeneration[];
  num_unsafe_generations: number;
  title: string;
  moderation_result: IModerationResult;
  failure_reason: any;
  needs_user_review: boolean;
}

export interface IActions {
  "16": string;
  "76": string;
  "136": string;
  "196": string;
  "256": string;
}

export interface IInpaintItem {
  crop_bounds: any;
  type: string;
  preset_id: any;
  generation_id: string;
  upload_media_id: any;
  frame_index: number;
  source_start_frame: number;
  source_end_frame: number;
}

export interface IGeneration {
  id: string;
  task_id: string;
  created_at: string;
  deleted_at: any;
  url: string;
  seed: number;
  can_download: boolean;
  download_status: string;
  is_favorite: any;
  is_liked: any;
  is_public: boolean;
  is_archived: boolean;
  is_featured: any;
  featured_countries: any;
  has_feedback: any;
  like_count: number;
  num_direct_children: number;
  cloudflare_metadata: any;
  cf_thumbnail_url: any;
  encodings: IEncodings;
  width: number;
  height: number;
  n_frames: number;
  prompt: any;
  title: string;
  actions: IActions;
  inpaint_items: IInpaintItem[];
  interpolation: any;
  sdedit: any;
  operation: string;
  model: string;
  preset_id: any;
  user: IUser;
  moderation_result: IModerationResult;
  paragen_status: any;
  task_type: string;
  remix_config: any;
  quality: any;
}

export interface IEncodings {
  source: ISource;
  md: IMd;
  ld: ILd;
  thumbnail: IThumbnail;
  spritesheet: ISpritesheet;
}

export interface ISource {
  path: string;
  size: number;
  width: number;
  height: number;
  duration_secs: number;
  ssim: number;
}

export interface IMd {
  path: string;
  size: number;
  width: number;
  height: number;
  duration_secs: number;
  ssim: number;
}

export interface ILd {
  path: string;
  size: number;
  width: number;
  height: number;
  duration_secs: number;
  ssim: number;
}

export interface IThumbnail {
  path: string;
  size: any;
}

export interface ISpritesheet {
  path: string;
  size: any;
}

export interface IUser {
  id: string;
  username: string;
}

export interface IModerationResult {
  type: string;
  results_by_frame_index: IResultsByFrameIndex;
  code: any;
  is_output_rejection: boolean;
  task_id: string;
}

export interface IResultsByFrameIndex {}
