import { withAuth } from '@lib/auth/withAuth';
import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../../lib/db';
import { ADMIN_TRAINER_SELECT, toAdminTrainerRow } from '../../../lib/trainers/adminTrainerRow';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const result = await pool.query(`${ADMIN_TRAINER_SELECT} ORDER BY u.full_name ASC`);

    return res.status(200).json({
      success: true,
      data: { trainers: result.rows.map(toAdminTrainerRow) },
    });
  } catch (error) {
    console.error('Error listing trainers:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

export default withAuth(handler, { roles: ['admin'] });
