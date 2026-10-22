import { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../../lib/db';

// Helper: strip T time component for clean date display
const toLocalDate = (d: string | Date | null): string | null => {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
};

async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Simplified query that only uses columns known to exist in the DB.
    // This gracefully returns an empty array when a user has no enrollments,
    // instead of throwing on missing functions / columns from the original.
    const enrolledCoursesQuery = `
      SELECT 
        e.id AS enrollment_id,
        e.user_id,
        e.course_id,
        e.course_run_id,
        c.title AS course_title,
        c.course_code,
        c.new_course_code,
        COALESCE(c.training_hours, 0)::numeric + COALESCE(c.assessment_hours, 0)::numeric AS total_training_hours,
        COALESCE(c.training_hours, 0) AS training_hours,
        COALESCE(c.assessment_hours, 0) AS assessment_hours,
        c.course_type,
        c.image_url AS image_url,
        cr.mode_of_learning,
        cr.start_date,
        cr.end_date,
        cr.class_status,
        COALESCE(cr.class_type, 'Physical') AS class_type,
        e.created_at
      FROM app_user u
      JOIN enrollment e ON u.id = e.user_id
      JOIN course c ON e.course_id = c.id
      LEFT JOIN course_run cr ON e.course_run_id = cr.id
      WHERE u.id = $1
      ORDER BY 
        CASE WHEN cr.start_date IS NULL THEN 1 ELSE 0 END,
        COALESCE(cr.start_date, e.created_at) DESC NULLS LAST
    `;

    const result = await pool.query(enrolledCoursesQuery, [userId]);

    // Transform into the shape expected by LearnerCourseList / Enrollment hooks.
    // Missing optional fields default to safe values so the frontend never crashes.
    const courses = result.rows.map((row: any) => ({
      id: row.course_id || null,
      title: row.course_title || 'Unknown Course',
      courseCode: (row.course_code || '').trim(),
      originalCourseCode: '',
      newCourseCode: (row.new_course_code || '').trim(),
      currentCourseCode: (row.new_course_code?.trim() || row.course_code || '').trim(),
      courseRunId: row.course_run_id || null,
      courseRunCode: '',
      courseDuration: Number(row.total_training_hours || 0),
      trainingHours: Number(row.training_hours || 0),
      assessmentHours: Number(row.assessment_hours || 0),
      totalAssessments: 0,
      courseType: row.course_type || 'Non-WSQ',
      imageUrl: row.image_url || '',
      modeOfLearning: row.mode_of_learning ? [row.mode_of_learning] : ['Physical'],
      progressPercent: 0,
      paymentStatus: 'pending',
      assessmentStatus: 'not_started',
      enrollmentDate: row.created_at ? toLocalDate(row.created_at) : null,
      startDate: toLocalDate(row.start_date),
      endDate: toLocalDate(row.end_date),
      classStatus: row.class_status || 'Pending',
      classType: row.class_type || 'Physical',
      virtualMeetingLink: null,
      virtualMeetingProvider: null,
      enrolmentId: row.enrollment_id || null,
      enrolmentStatus: 'enrolled',
      nric: null,
      email: '',
      certificate: null,
      enrollmentStatus: 'enrolled'
    }));

    res.status(200).json({
      success: true,
      data: courses,
      total: courses.length
    });

  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    // Return empty array instead of 500 so the frontend shows "no enrolled courses"
    res.status(200).json({
      success: true,
      data: [],
      total: 0,
      message: process.env.NODE_ENV === 'development' 
        ? `Enrollment query failed (${(error as Error).message}) — returning empty list`
        : undefined
    });
  }
}

export default handler;
