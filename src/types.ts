export interface ZeptoMailAgent {
  mailagent_name: string;
  mailagent_key: string;
  created_time?: string;
  description?: string;
  status?: string;
}

export interface AgentListResponse {
  data?: ZeptoMailAgent[];
  status?: string;
}

export interface ZeptoMailTemplateSummary {
  template_name: string;
  template_key: string;
  template_alias?: string;
  subject?: string;
  created_time?: string;
  modified_time?: string;
}

export interface ZeptoMailAttachment {
  file_cache_key?: string;
  content_type?: string;
  file_name?: string;
}

export interface ZeptoMailTemplate extends ZeptoMailTemplateSummary {
  htmlbody?: string;
  textbody?: string;
  attachments?: ZeptoMailAttachment[];
  sample_merge_info?: Record<string, unknown>;
}

export interface ScopedTemplateSummary {
  agent: ZeptoMailAgent;
  template: ZeptoMailTemplateSummary;
}

export interface TemplateListResponse {
  metadata?: {
    offset?: number;
    count?: number;
    limit?: number;
  };
  data?: ZeptoMailTemplateSummary[];
  message?: string;
  object?: string;
}

export interface TemplateGetResponse {
  data?: ZeptoMailTemplate;
  message?: string;
  object?: string;
}

export interface TemplateMutationResponse {
  data?: ZeptoMailTemplate[] | ZeptoMailTemplate;
  message?: string;
  object?: string;
  status?: unknown;
}
