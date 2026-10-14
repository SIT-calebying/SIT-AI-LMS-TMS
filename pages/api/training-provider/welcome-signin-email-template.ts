import { withAuth } from '@lib/auth/withAuth';
import pool from '../../../lib/db';
import { cors } from '../../../lib/cors';
import { NextApiRequest, NextApiResponse } from 'next';
import { ensureSigninRequestTable } from '@lib/learner/selfEnrolment';

// GET/PUT the "Learner Welcome Email" sent after a learner enrols themselves from the
// login page (or staff resolve their sign-in request). Empty = built-in default.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  await cors(req, res);
  await ensureSigninRequestTable();

  if (req.method === 'GET') {
    try {
      const result = await pool.query('SELECT welcome_signin_email_subject, welcome_signin_email_body FROM training_provider LIMIT 1');
      return res.status(200).json({
        success: true,
        data: {
          welcomeSigninEmailSubject: result.rows[0]?.welcome_signin_email_subject ?? null,
          welcomeSigninEmailBody: result.rows[0]?.welcome_signin_email_body ?? null,
        },
      });
    } catch (error) {
      console.error('Error fetching welcome sign-in email template:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch learner welcome email template' });
    }
  }

  if (req.method === 'PUT') {
    const { welcomeSigninEmailSubject, welcomeSigninEmailBody } = req.body;
    if (typeof welcomeSigninEmailSubject !== 'string' || typeof welcomeSigninEmailBody !== 'string') {
      return res.status(400).json({ success: false, error: 'welcomeSigninEmailSubject and welcomeSigninEmailBody must be strings' });
    }
    try {
      await pool.query(
        'UPDATE training_provider SET welcome_signin_email_subject = $1, welcome_signin_email_body = $2',
        [welcomeSigninEmailSubject, welcomeSigninEmailBody]
      );
      return res.status(200).json({ success: true, message: 'Learner welcome email template updated successfully' });
    } catch (error) {
      console.error('Error updating welcome sign-in email template:', error);
      return res.status(500).json({ success: false, error: 'Failed to update learner welcome email template' });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}

export default withAuth(handler, { roles: ['admin', 'trainingProvider'] });
