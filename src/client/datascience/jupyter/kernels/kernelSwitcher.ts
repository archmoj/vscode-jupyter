// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import { ProgressLocation, ProgressOptions } from 'vscode';
import { IApplicationShell } from '../../../common/application/types';
import { traceInfoIf } from '../../../common/logger';
import { IConfigurationService } from '../../../common/types';
import { DataScience } from '../../../common/utils/localize';
import { JupyterSessionStartError } from '../../baseJupyterSession';
import { RawKernelSessionStartError } from '../../raw-kernel/rawJupyterSession';
import { INotebook } from '../../types';
import { JupyterInvalidKernelError } from '../jupyterInvalidKernelError';
import { getDisplayNameOrNameOfKernelConnection, isLocalLaunch } from './helpers';
import { KernelSelector } from './kernelSelector';
import { KernelConnectionMetadata } from './types';

@injectable()
export class KernelSwitcher {
    constructor(
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private appShell: IApplicationShell,
        @inject(KernelSelector) private readonly selector: KernelSelector
    ) {}

    public async switchKernelWithRetry(notebook: INotebook, kernel: KernelConnectionMetadata): Promise<void> {
        const isLocalConnection = notebook.connection?.localLaunch ?? isLocalLaunch(this.configService);
        if (!notebook.connection?.localLaunch) {
            await this.switchToKernel(notebook, kernel);
            return;
        }

        // Keep retrying, until it works or user cancels.
        // Sometimes if a bad kernel is selected, starting a session can fail.
        // In such cases we need to let the user know about this and prompt them to select another kernel.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                traceInfoIf(
                    !!process.env.VSC_JUPYTER_LOG_KERNEL_OUTPUT,
                    `KernelSwitcher: Attempting switch to ${kernel.id}`
                );

                await this.switchToKernel(notebook, kernel);
                return;
            } catch (ex) {
                if (
                    isLocalConnection &&
                    (ex instanceof JupyterSessionStartError ||
                        ex instanceof JupyterInvalidKernelError ||
                        ex instanceof RawKernelSessionStartError)
                ) {
                    // Looks like we were unable to start a session for the local connection.
                    // Possibly something wrong with the kernel.
                    // At this point we have a valid jupyter server.
                    const potential = await this.selector.askForLocalKernel(
                        notebook.resource,
                        notebook.connection,
                        kernel
                    );
                    if (potential && Object.keys(potential).length > 0) {
                        kernel = potential;
                        continue;
                    }
                }
                throw ex;
            }
        }
    }
    private async switchToKernel(notebook: INotebook, kernelConnection: KernelConnectionMetadata): Promise<void> {
        const switchKernel = async (newKernelConnection: KernelConnectionMetadata) => {
            traceInfoIf(
                !!process.env.VSC_JUPYTER_LOG_KERNEL_OUTPUT,
                `Switching notebook kernel to ${kernelConnection.id}`
            );

            // Change the kernel. A status update should fire that changes our display
            await notebook.setKernelConnection(
                newKernelConnection,
                this.configService.getSettings(notebook.resource).jupyterLaunchTimeout
            );
        };

        const displayName = getDisplayNameOrNameOfKernelConnection(kernelConnection);
        const options: ProgressOptions = {
            location: ProgressLocation.Notification,
            cancellable: false,
            title: DataScience.switchingKernelProgress().format(displayName)
        };
        await this.appShell.withProgress(options, async (_, __) => switchKernel(kernelConnection!));
    }
}
