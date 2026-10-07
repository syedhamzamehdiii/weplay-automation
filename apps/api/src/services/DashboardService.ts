import type { AccountRepository } from "../repositories/AccountRepository.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { WorkerRepository } from "../repositories/WorkerRepository.js";
import type { SettingsService } from "../services/SettingsService.js";

export class DashboardService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly jobs: JobRepository,
    private readonly workers: WorkerRepository,
    private readonly settings: SettingsService
  ) {}

  async stats() {
    const [accountCounts, totalAccounts, jobCounts, workerCounts, settings] = await Promise.all([
      this.accounts.countsByStatus(),
      this.accounts.total(),
      this.jobs.counts(),
      this.workers.counts(),
      this.settings.read()
    ]);

    const setupRequired =
      (accountCounts.SETUP_REQUIRED ?? 0) +
      (accountCounts.SETUP_IN_PROGRESS ?? 0) +
      (accountCounts.NEW ?? 0);

    return {
      totalAccounts,
      readyAccounts: accountCounts.READY ?? 0,
      setupRequiredAccounts: setupRequired,
      needsReauthAccounts: accountCounts.NEEDS_REAUTH ?? 0,
      processingAccounts: accountCounts.PROCESSING ?? 0,
      successfulAccounts: accountCounts.SUCCESS ?? 0,
      failedAccounts: (accountCounts.FAILED ?? 0) + (accountCounts.CREATION_FAILED ?? 0),
      creatingAccounts: accountCounts.CREATING ?? 0,
      creationFailedAccounts: accountCounts.CREATION_FAILED ?? 0,
      actionRequiredAccounts: accountCounts.ACTION_REQUIRED ?? 0,
      onlineWorkers: workerCounts.online,
      offlineWorkers: workerCounts.offline,
      queuedJobs: jobCounts.queued,
      runningJobs: jobCounts.running,
      completedJobs: jobCounts.completed,
      controllerStatus: settings.controllerStatus
    };
  }
}
