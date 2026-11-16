import { FakeMoveConnection, type FakeMoveOptions } from "./fake-move";
import { REPORT_KINDS, isProviderReport, parseReportRequest, type ReportKind, type ReportLookup, type ReportRequest, type ReportResult } from "./interface";

export interface FakeReportOptions extends FakeMoveOptions {
  reportKinds?: readonly ReportKind[];
  lookup?: boolean;
  timeoutAfterReport?: boolean;
}

export interface FakeDraftedReport {
  requestId: string;
  messageId: string;
  attachedOriginal: string;
  folder: "Drafts";
  sent: false;
}

export class FakeReportConnection extends FakeMoveConnection {
  readonly reportKinds: readonly ReportKind[];
  readonly reported = new Map<string, { request: ReportRequest; result: ReportResult }>();
  readonly reportDrafts: FakeDraftedReport[] = [];
  readonly submissions: { requestId: string; messageId: string; kind: ReportKind }[] = [];
  readonly sent: string[] = [];
  readonly lookupReport?: (requestId: string) => Promise<unknown>;
  timeoutAfterReport: boolean;

  constructor(options: FakeReportOptions = {}) {
    super(options);
    this.reportKinds = options.reportKinds ?? REPORT_KINDS;
    this.timeoutAfterReport = options.timeoutAfterReport ?? false;
    if (options.lookup !== false) this.lookupReport = requestId => this.lookupSaved(requestId);
  }

  async report(raw: ReportRequest): Promise<unknown> {
    const request = parseReportRequest(raw);
    if (!request || !this.reportKinds.includes(request.kind)) throw new Error("The report kind is not offered.");
    const old = this.reported.get(request.requestId);
    if (old) return JSON.stringify(old.request) === JSON.stringify(request) ? structuredClone(old.result) : Promise.reject(new Error("The request ID names a different report."));
    const id = request.message.canonicalId;
    const from = this.folders.get(id);
    if (from === undefined) throw new Error("The message no longer exists.");
    let folder: string;
    if (isProviderReport(request.kind)) {
      this.previous.set(id, from);
      this.folders.set(id, "Junk");
      this.submissions.push({ requestId: request.requestId, messageId: id, kind: request.kind });
      this.effects.push({ requestId: request.requestId, messageId: id, from, to: "Junk" });
      folder = "Junk";
    } else {
      this.reportDrafts.push({ requestId: request.requestId, messageId: id, attachedOriginal: id, folder: "Drafts", sent: false });
      folder = "Drafts";
    }
    const result = { ref: structuredClone(request.message), folder };
    this.reported.set(request.requestId, { request: structuredClone(request), result });
    if (this.timeoutAfterReport) return new Promise(() => {});
    return structuredClone(result);
  }

  private async lookupSaved(requestId: string): Promise<ReportLookup> {
    const saved = this.reported.get(requestId);
    return saved ? { status: "found", ...structuredClone(saved) } : { status: "not_found" };
  }
}
