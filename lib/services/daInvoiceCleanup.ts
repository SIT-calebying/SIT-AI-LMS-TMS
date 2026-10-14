import pool from '../db';
import { qboReadInvoice, qboDeleteInvoice } from './qboInvoiceService';

interface DaInvoiceRow {
  application_id: string;
  invoice_id: string | null;
  grant_invoice_id: string | null;
  sfc_invoice_id: string | null;
}

/**
 * Best-effort delete of a QBO invoice. Returns a warning string when the
 * deletion failed for a real reason, or `null` when the invoice was deleted
 * (or was already gone — QBO error 610 = Object Not Found).
 */
export async function deleteQboInvoiceIfPresent(
  invoiceId: string | null | undefined,
  label: string,
): Promise<string | null> {
  const id = (invoiceId || '').trim();
  if (!id || /^(manual|n\/a|-)$/i.test(id)) return null;
  try {
    const inv = await qboReadInvoice(undefined, id);
    if (inv?.syncToken) {
      await qboDeleteInvoice(undefined, id, inv.syncToken);
    } else {
      return `${label}: QuickBooks returned no SyncToken for invoice ${id}`;
    }
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    if (msg.includes('610') || lower.includes('not found') || lower.includes('object not found')) {
      return null;
    }
    return `${label}: ${msg}`;
  }
}

/**
 * Delete the three QBO invoices (main / grant / SFC) attached to a DA row
 * and null out only successfully deleted invoice columns. QBO failures are returned
 * as warnings. Database write failures throw so retries retain their references.
 */
async function deleteDaInvoices(da: DaInvoiceRow, removeInvoice = deleteQboInvoiceIfPresent): Promise<string[]> {
  const [mainW, grantW, sfcW] = await Promise.all([
    removeInvoice(da.invoice_id, 'main'),
    removeInvoice(da.grant_invoice_id, 'grant'),
    removeInvoice(da.sfc_invoice_id, 'sfc'),
  ]);
  const warnings = [mainW, grantW, sfcW].filter((w): w is string => !!w);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE da_application
     SET application_status = 'Cancelled',
         enrolment_status = 'Cancelled',
         invoice_id = CASE WHEN $2 THEN NULL ELSE invoice_id END,
         invoice_doc_number = CASE WHEN $2 THEN NULL ELSE invoice_doc_number END,
         invoice_no = CASE WHEN $2 THEN NULL ELSE invoice_no END,
         invoice_drive_file_id = CASE WHEN $2 THEN NULL ELSE invoice_drive_file_id END,
         invoice_drive_web_view_link = CASE WHEN $2 THEN NULL ELSE invoice_drive_web_view_link END,
         grant_invoice_id = CASE WHEN $3 THEN NULL ELSE grant_invoice_id END,
         grant_invoice_drive_file_id = CASE WHEN $3 THEN NULL ELSE grant_invoice_drive_file_id END,
         grant_invoice_drive_web_view_link = CASE WHEN $3 THEN NULL ELSE grant_invoice_drive_web_view_link END,
         sfc_invoice_id = CASE WHEN $4 THEN NULL ELSE sfc_invoice_id END,
         sfc_invoice_drive_file_id = CASE WHEN $4 THEN NULL ELSE sfc_invoice_drive_file_id END,
         sfc_invoice_drive_web_view_link = CASE WHEN $4 THEN NULL ELSE sfc_invoice_drive_web_view_link END,
         updated_at = NOW()
     WHERE application_id = $1`,
      [da.application_id, !mainW, !grantW, !sfcW]
    );

    if (!mainW && da.invoice_id && !/^(manual|n\/a|-)$/i.test(da.invoice_id.trim())) {
      await client.query(`UPDATE invoice_jobs SET status = 'cancelled', qbo_invoice_id = NULL,
      qbo_doc_number = NULL, invoice_no = NULL, drive_file_id = NULL, drive_web_view_link = NULL,
      last_error = 'Direct Application cancelled; invoice removed', updated_at = NOW()
      WHERE qbo_invoice_id = $1`, [da.invoice_id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }

  return warnings;
}

/**
 * If this enrolment belongs to a Direct Application, delete the three QBO
 * invoices (main / grant / SFC) attached to the DA row. Best-effort —
 * failures are returned as warnings and never block the caller.
 */
export async function cleanupDaInvoicesForEnrolment(
  enrolmentId: string
): Promise<{ found: boolean; warnings: string[] }> {
  const r = await pool.query(
    `SELECT application_id, invoice_id, grant_invoice_id, sfc_invoice_id
     FROM da_application
     WHERE enrolment_id = $1
     LIMIT 1`,
    [enrolmentId]
  );
  const da = r.rows[0] as DaInvoiceRow | undefined;
  if (!da) return { found: false, warnings: [] };
  const warnings = await deleteDaInvoices(da);
  return { found: true, warnings };
}

/**
 * Same as {@link cleanupDaInvoicesForEnrolment}, but looked up by
 * `da_application.application_id` — use this when the caller already has
 * the DA row loaded and doesn't want to rely on `enrolment_id` matching.
 */
export async function cleanupDaInvoicesForApplicationId(
  applicationId: string,
  removeInvoice = deleteQboInvoiceIfPresent,
): Promise<{ found: boolean; warnings: string[] }> {
  const r = await pool.query(
    `SELECT application_id, invoice_id, grant_invoice_id, sfc_invoice_id
     FROM da_application
     WHERE application_id = $1
     LIMIT 1`,
    [applicationId]
  );
  const da = r.rows[0] as DaInvoiceRow | undefined;
  if (!da) return { found: false, warnings: [] };
  const warnings = await deleteDaInvoices(da, removeInvoice);
  return { found: true, warnings };
}
