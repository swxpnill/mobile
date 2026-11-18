import { REPORT_KINDS, type ReportKind, buildReport, checkRange, istDateOf, reportQuerySchema } from '@tonnage/shared';
import { notFound, validationError } from '../errors.ts';
import { reportFacts } from '../report-facts.ts';
import { route, type RouteDef } from '../router.ts';
import { authed } from '../views.ts';

const isKind = (s: string | undefined): s is ReportKind => REPORT_KINDS.some((k) => k === s);

export const reportRoutes: RouteDef[] = [
  route('GET', '/v1/reports/:kind', {
    action: 'reports.view',
    query: reportQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const kind = ctx.params.kind;
      if (!isKind(kind)) throw notFound();
      const { from, to, ...rest } = ctx.query;
      const today = istDateOf(ctx.now);
      // "Pending orders" is as of now: its range is not checked either.
      const range = kind === 'pending-orders' ? 'ok' : checkRange(from, to, today);
      if (range === 'ORDER') throw validationError([{ path: ['to'], message: 'To is before from' }]);
      if (range === 'FUTURE') throw validationError([{ path: ['to'], message: 'Date cannot be in the future' }]);
      if (range === 'TOO_LONG') throw validationError([{ path: ['from'], message: 'The range is too long' }]);
      const facts = reportFacts(ctx.state, a.user.tenantId, kind);
      return {
        body: buildReport(kind, facts, { from, to, today, agedOrderDays: a.tenant.settings.agedOrderDays, ...rest }),
      };
    },
  }),
];
