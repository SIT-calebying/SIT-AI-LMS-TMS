import { withAuth } from '@lib/auth/withAuth';
import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../../lib/db';
import { ADMIN_TRAINER_SELECT, toAdminTrainerRow } from '../../../lib/trainers/adminTrainerRow';

// Admin edit of a trainer's profile from the Search Trainers page. Login email
// and status are deliberately not editable here (status has its own route,
// update-trainer-status). NRIC is only written when a new value is sent, so the
// form never needs the full NRIC to save other fields.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = ['Male', 'Female', 'Prefer not to say'];
const TRAINER_TYPES = ['ACLP', 'non-ACLP', 'DACE'];

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};

const tagList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = String(item ?? '').trim();
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const { trainerId, details } = req.body || {};
  if (!trainerId || typeof trainerId !== 'string' || !UUID_RE.test(trainerId)) {
    return res.status(400).json({ success: false, message: 'A valid trainer id is required' });
  }
  if (!details || typeof details !== 'object') {
    return res.status(400).json({ success: false, message: 'Trainer details are required' });
  }

  const fullName = text(details.full_name);
  const tel = text(details.tel);
  const dob = text(details.dob);
  const gender = text(details.gender);
  const trainerType = text(details.trainer_type);
  const newNric = text(details.new_nric);

  if (!fullName) return res.status(400).json({ success: false, message: 'Name is required' });
  if (!tel) return res.status(400).json({ success: false, message: 'Phone number is required' });
  if (dob && (!DATE_RE.test(dob) || Number.isNaN(Date.parse(dob)))) {
    return res.status(400).json({ success: false, message: 'Date of birth must be a valid date' });
  }
  if (!gender || !GENDERS.includes(gender)) {
    return res.status(400).json({ success: false, message: 'Select a gender' });
  }
  if (!trainerType || !TRAINER_TYPES.includes(trainerType)) {
    return res.status(400).json({ success: false, message: 'Select a trainer type' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'UPDATE app_user SET full_name = $1, secondary_email = $2, updated_at = now() WHERE id = $3',
      [fullName, text(details.secondary_email), trainerId],
    );

    const profileResult = await client.query(
      `UPDATE trainer_profile SET
         common_name = $1,
         tel = $2,
         cn_plus_email = $3,
         dob = $4,
         gender = $5,
         nationality = $6,
         country = $7,
         ethnicity = $8,
         trainer_type = $9,
         linkedin_url = $10,
         areas_of_expertise = $11::jsonb,
         skills_tags = $12::jsonb,
         certification_tags = $13::jsonb,
         qualifications = $14::jsonb,
         education = $15,
         nric = COALESCE($16, nric)
       WHERE user_id = $17`,
      [
        text(details.common_name),
        tel,
        text(details.cn_plus_email),
        dob,
        gender,
        text(details.nationality),
        text(details.country),
        text(details.ethnicity),
        trainerType,
        text(details.linkedin_url),
        JSON.stringify(tagList(details.domains)),
        JSON.stringify(tagList(details.skills)),
        JSON.stringify(tagList(details.certifications)),
        JSON.stringify(tagList(details.qualifications)),
        text(details.education),
        newNric ? newNric.toUpperCase() : null,
        trainerId,
      ],
    );

    if (userResult.rowCount === 0 || profileResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Trainer not found' });
    }

    await client.query('COMMIT');

    const updated = await pool.query(`${ADMIN_TRAINER_SELECT} WHERE u.id = $1`, [trainerId]);
    return res.status(200).json({ success: true, data: { trainer: toAdminTrainerRow(updated.rows[0]) } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating trainer details:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
}

export default withAuth(handler, { roles: ['admin'] });
