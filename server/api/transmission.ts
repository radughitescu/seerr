import type { TransmissionSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

export interface TorrentInfo {
  hashString: string;
  name: string;
  status: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  percentDone: number;
  rateDownload: number;
  eta: number;
  peersSendingToUs: number;
  peersConnected: number;
  sizeWhenDone: number;
  error: number;
  errorString: string;
  files: {
    index: number;
    name: string;
    length: number;
    bytesCompleted: number;
  }[];
  fileStats: { wanted: boolean; priority: -1 | 0 | 1 }[];
}

const TORRENT_FIELDS = [
  'hashString',
  'name',
  'status',
  'percentDone',
  'rateDownload',
  'eta',
  'peersSendingToUs',
  'peersConnected',
  'sizeWhenDone',
  'error',
  'errorString',
  'files',
  'fileStats',
];

interface RpcResponse<T> {
  result: string;
  arguments: T;
}

const lower = (hashes: string[]) => hashes.map((h) => h.toLowerCase());

class TransmissionAPI {
  private axios: AxiosInstance;
  private sessionId?: string;

  constructor(settings: TransmissionSettings) {
    const protocol = settings.useSsl ? 'https' : 'http';
    this.axios = axios.create({
      baseURL: `${protocol}://${settings.hostname}:${settings.port}${settings.rpcPath}`,
      timeout: 10000,
      auth: settings.username
        ? { username: settings.username, password: settings.password }
        : undefined,
    });
  }

  private async rpc<T>(
    method: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    const send = () =>
      this.axios.post<RpcResponse<T>>(
        '',
        { method, arguments: args },
        {
          headers: this.sessionId
            ? { 'X-Transmission-Session-Id': this.sessionId }
            : {},
        }
      );

    let response;
    try {
      response = await send();
    } catch (e) {
      const err = e as {
        response?: { status?: number; headers?: Record<string, string> };
      };
      const newId = err.response?.headers?.['x-transmission-session-id'];
      if (err.response?.status === 409 && newId) {
        this.sessionId = newId;
        response = await send();
      } else {
        throw e;
      }
    }

    if (response.data.result !== 'success') {
      throw new Error(`Transmission error: ${response.data.result}`);
    }
    return response.data.arguments;
  }

  public async getTorrents(hashes: string[]): Promise<TorrentInfo[]> {
    if (hashes.length === 0) {
      return [];
    }
    const res = await this.rpc<{ torrents: TorrentInfo[] }>('torrent-get', {
      ids: lower(hashes),
      fields: TORRENT_FIELDS,
    });
    return res.torrents.map((t) => ({
      ...t,
      files: (t.files ?? []).map((f, i) => ({ ...f, index: i })),
    }));
  }

  public async start(hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.rpc('torrent-start', { ids: lower(hashes) });
  }

  public async stop(hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.rpc('torrent-stop', { ids: lower(hashes) });
  }

  public async remove(
    hashes: string[],
    deleteLocalData: boolean
  ): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.rpc('torrent-remove', {
      ids: lower(hashes),
      'delete-local-data': deleteLocalData,
    });
  }

  public async setFilesWanted(
    hash: string,
    fileIndexes: number[],
    wanted: boolean
  ): Promise<void> {
    if (fileIndexes.length === 0) {
      return;
    }
    await this.rpc('torrent-set', {
      ids: lower([hash]),
      [wanted ? 'files-wanted' : 'files-unwanted']: fileIndexes,
    });
  }

  public async setFilePriorityHigh(
    hash: string,
    fileIndexes: number[]
  ): Promise<void> {
    if (fileIndexes.length === 0) {
      return;
    }
    await this.rpc('torrent-set', {
      ids: lower([hash]),
      'priority-high': fileIndexes,
    });
  }

  public async queueMoveTop(hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.rpc('queue-move-top', { ids: lower(hashes) });
  }

  public async setBandwidthPriorityHigh(hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.rpc('torrent-set', {
      ids: lower(hashes),
      bandwidthPriority: 1,
    });
  }

  public async test(): Promise<{ version: string }> {
    const res = await this.rpc<{ version: string }>('session-get', {
      fields: ['version'],
    });
    return { version: res.version };
  }
}

export default TransmissionAPI;
