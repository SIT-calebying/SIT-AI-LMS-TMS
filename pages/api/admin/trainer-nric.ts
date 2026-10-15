import { withAuth } from '@lib/auth/withAuth';
import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../../lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reveals one trainer's full NRIC on demand (Search Trainers eye toggle), so
// search results themselves only ever carry the masked value.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const { trainerId } = req.body || {};

  if (!trainerId || typeof trainerId !== 'string' || !UUID_RE.test(trainerId)) {
    return res.status(400).json({ success: false, message: 'A valid trainer id is required' });
  }

  try {
    const result = await pool.query('SELECT nric FROM trainer_profile WHERE user_id = $1', [trainerId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Trainer not found' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { nric: result.rows[0].nric || null } });
  } catch (error) {
    console.error('Error fetching trainer NRIC:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

export default withAuth(handler, { roles: ['admin'] });
