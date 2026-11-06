export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface TransportRequest {
  method: HttpMethod;
  /** Path including query string, e.g. `/v1/plants?companyId=…`. */
  path: string;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON body; `null` when the response has no body (e.g. 204). */
  body: unknown;
}

export interface Transport {
  /** Rejects with `NetworkError` when the request could not reach the server. */
  request(req: TransportRequest): Promise<TransportResponse>;
}

export class NetworkError extends Error {
  constructor(message = 'Network request failed') {
    super(message);
    this.name = 'NetworkError';
  }
}
