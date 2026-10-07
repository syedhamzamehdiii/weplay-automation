import type { AppEnv } from "@weplay/config";
import type { DbClient } from "./db/types.js";
import { EventBus } from "./events/bus.js";
import type { GoogleDirectoryClient } from "./google/directory.js";
import { createGoogleDirectoryClient } from "./google/googleDirectoryClient.js";
import { AccountRepository } from "./repositories/AccountRepository.js";
import { EventLogRepository } from "./repositories/EventLogRepository.js";
import { JobRepository } from "./repositories/JobRepository.js";
import { OperatorRepository } from "./repositories/OperatorRepository.js";
import { RunRepository } from "./repositories/RunRepository.js";
import { SettingsRepository } from "./repositories/SettingsRepository.js";
import { WorkerRepository } from "./repositories/WorkerRepository.js";
import { WorkspaceProvisioningRepository } from "./repositories/WorkspaceProvisioningRepository.js";
import { AccountService } from "./services/AccountService.js";
import { AuthService } from "./services/AuthService.js";
import { DashboardService } from "./services/DashboardService.js";
import { JobService } from "./services/JobService.js";
import { LogService } from "./services/LogService.js";
import { RunService } from "./services/RunService.js";
import { SettingsService } from "./services/SettingsService.js";
import { WorkerService } from "./services/WorkerService.js";
import { WorkspaceProvisioningService } from "./services/WorkspaceProvisioningService.js";
import { DeviceFarmProvisioningService } from "./services/DeviceFarmProvisioningService.js";
import { Controller } from "./controller/Controller.js";
import { DeviceFarmProvisioningRepository } from "./repositories/DeviceFarmProvisioningRepository.js";
import type { DeviceFarmWorkerClient } from "./devicefarm/client.js";
import { createDeviceFarmClient } from "./devicefarm/awsClient.js";

export interface AppContext {
  env: AppEnv;
  db: DbClient;
  bus: EventBus;
  accounts: AccountService;
  workers: WorkerService;
  jobs: JobService;
  runs: RunService;
  logs: LogService;
  settings: SettingsService;
  auth: AuthService;
  dashboard: DashboardService;
  workspace: WorkspaceProvisioningService;
  deviceFarm: DeviceFarmProvisioningService;
  controller: Controller;
  accountRepo: AccountRepository;
  jobRepo: JobRepository;
}

export function createContext(
  env: AppEnv,
  db: DbClient,
  options: { directoryClient?: GoogleDirectoryClient; deviceFarmClient?: DeviceFarmWorkerClient } = {}
): AppContext {
  const bus = new EventBus();
  const accountRepo = new AccountRepository(db);
  const workerRepo = new WorkerRepository(db);
  const jobRepo = new JobRepository(db);
  const runRepo = new RunRepository(db);
  const logRepo = new EventLogRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const operatorRepo = new OperatorRepository(db);
  const workspaceRepo = new WorkspaceProvisioningRepository(db);
  const deviceFarmRepo = new DeviceFarmProvisioningRepository(db);
  const directory = options.directoryClient ?? createGoogleDirectoryClient(env);
  const deviceFarmClient = options.deviceFarmClient ?? createDeviceFarmClient(env);

  const logs = new LogService(logRepo, bus);
  const settings = new SettingsService(settingsRepo, env, logs);
  const auth = new AuthService(operatorRepo);
    const accounts = new AccountService(accountRepo, jobRepo, workerRepo, logs, bus, directory);
  const workers = new WorkerService(workerRepo, accountRepo, logs, bus, env);
  const jobs = new JobService(db, jobRepo, accountRepo, workerRepo, logs, bus, settings);
  const runs = new RunService(runRepo, jobRepo, settings, logs, bus);
  const dashboard = new DashboardService(accountRepo, jobRepo, workerRepo, settings);
  const workspace = new WorkspaceProvisioningService(env, workspaceRepo, jobRepo, jobs, logs, bus, directory);
  const deviceFarm = new DeviceFarmProvisioningService(
    env,
    deviceFarmRepo,
    accounts,
    accountRepo,
    jobRepo,
    jobs,
    logs,
    bus,
    directory,
    deviceFarmClient
  );
  const controller = new Controller(
    accountRepo,
    jobRepo,
    workerRepo,
    runRepo,
    jobs,
    runs,
    settings,
    logs,
    bus,
    workspace,
    deviceFarm
  );

  return {
    env,
    db,
    bus,
    accounts,
    workers,
    jobs,
    runs,
    logs,
    settings,
    auth,
    dashboard,
    workspace,
    deviceFarm,
    controller,
    accountRepo,
    jobRepo
  };
}
