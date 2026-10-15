// Shared shape for the admin Search Trainers page: the list route and the edit
// route both return trainers through this SELECT + mapper, so the UI can swap a
// row in place after an edit. The full NRIC never leaves here — only a mask.

export const ADMIN_TRAINER_SELECT = `
  SELECT
    u.id,
    u.full_name,
    tp.common_name,
    u.email,
    u.secondary_email,
    tp.tel,
    tp.nric,
    tp.status,
    tp.trainer_type,
    tp.cn_plus_email,
    to_char(tp.dob, 'YYYY-MM-DD') AS dob,
    tp.gender,
    tp.nationality,
    tp.country,
    tp.ethnicity,
    tp.areas_of_expertise,
    tp.skills_tags,
    tp.certification_tags,
    tp.qualifications,
    tp.education,
    tp.linkedin_url,
    tp.cv_url,
    tp.cv_folder_url
  FROM trainer_profile tp
  JOIN app_user u ON u.id = tp.user_id
`;

export interface AdminTrainerRow {
  id: string;
  full_name: string | null;
  common_name: string | null;
  email: string | null;
  secondary_email: string | null;
  tel: string | null;
  nric_masked: string | null;
  status: string | null;
  trainer_type: string | null;
  cn_plus_email: string | null;
  dob: string | null;
  gender: string | null;
  nationality: string | null;
  country: string | null;
  ethnicity: string | null;
  domains: string[];
  skills: string[];
  certifications: string[];
  qualifications: string[];
  education: string | null;
  linkedin_url: string | null;
  cv_url: string | null;
  cv_folder_url: string | null;
}

export function maskNric(value: string | null | undefined): string | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.length <= 4) return 'X'.repeat(raw.length);
  return 'X'.repeat(raw.length - 4) + raw.slice(-4);
}

// jsonb list columns hold string arrays, but older rows can be '{}' or a JSON string.
export function toStringArray(value: unknown): string[] {
  let v = value;
  if (typeof value === 'string') {
    try { v = JSON.parse(value); } catch { return value.trim() ? [value.trim()] : []; }
  }
  if (!Array.isArray(v)) return [];
  return v.map(item => String(item ?? '').trim()).filter(Boolean);
}

export function toAdminTrainerRow(row: any): AdminTrainerRow {
  return {
    id: row.id,
    full_name: row.full_name,
    common_name: row.common_name,
    email: row.email,
    secondary_email: row.secondary_email,
    tel: row.tel,
    nric_masked: maskNric(row.nric),
    status: row.status,
    trainer_type: row.trainer_type,
    cn_plus_email: row.cn_plus_email,
    dob: row.dob,
    gender: row.gender,
    nationality: row.nationality,
    country: row.country,
    ethnicity: row.ethnicity,
    domains: toStringArray(row.areas_of_expertise),
    skills: toStringArray(row.skills_tags),
    certifications: toStringArray(row.certification_tags),
    qualifications: toStringArray(row.qualifications),
    education: row.education,
    linkedin_url: row.linkedin_url,
    cv_url: row.cv_url,
    cv_folder_url: row.cv_folder_url,
  };
}
