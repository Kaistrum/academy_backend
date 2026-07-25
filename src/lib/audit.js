import { AuditLogs } from '../db/collections.js';

/**
 * Records admin actions (§2.13): deletes, role changes, refunds, publishes.
 * Audit failures must never break the action being audited.
 */
export async function recordAudit(req, { action, targetType, targetId, meta = {} }) {
  try {
    await AuditLogs().insertOne({
      actorId: req.user?._id ?? null,
      actorEmail: req.user?.email ?? null,
      action,
      targetType,
      targetId: targetId ?? null,
      meta,
      ip: req.ip ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    console.warn('[audit] failed to record action', action, err.message);
  }
}
