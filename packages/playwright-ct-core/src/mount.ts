/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Fixtures, Locator, Page, BrowserContextOptions, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, BrowserContext } from 'playwright/test';
import type { Component, ImportRef, JsxComponent, MountOptions, ObjectComponentOptions } from '../types/component';
import type { ContextReuseMode, FullConfigInternal } from '../../playwright/src/common/config';

let boundCallbacksForMount: Function[] = [];

interface MountResult extends Locator {
  unmount(locator: Locator): Promise<void>;
  update(options: Omit<MountOptions, 'hooksConfig'> | string | JsxComponent): Promise<void>;
}

type TestFixtures = PlaywrightTestArgs & PlaywrightTestOptions & {
  mount: (component: any, options: any) => Promise<MountResult>;
};
type WorkerFixtures = PlaywrightWorkerArgs & PlaywrightWorkerOptions & { _ctWorker: { context: BrowserContext | undefined, hash: string } };
type BaseTestFixtures = {
  _contextFactory: (options?: BrowserContextOptions) => Promise<BrowserContext>,
  _contextReuseMode: ContextReuseMode
};

export const fixtures: Fixtures<TestFixtures, WorkerFixtures, BaseTestFixtures> = {

  _contextReuseMode: 'when-possible',

  serviceWorkers: 'block',

  _ctWorker: [{ context: undefined, hash: '' }, { scope: 'worker' }],

  page: async ({ page }, use, info) => {
    if (!((info as any)._configInternal as FullConfigInternal).defineConfigWasUsed)
      throw new Error('Component testing requires the use of the defineConfig() in your playwright-ct.config.{ts,js}: https://aka.ms/playwright/ct-define-config');
    await (page as any)._wrapApiCall(async () => {
      await page.exposeFunction('__ct_dispatch', (ordinal: number, args: any[]) => {
        boundCallbacksForMount[ordinal](...args);
      });
      await page.goto(process.env.PLAYWRIGHT_TEST_BASE_URL!);
    }, true);
    await use(page);
  },

  mount: async ({ page }, use) => {
    await use(async (componentRef: JsxComponent | ImportRef, options?: ObjectComponentOptions & MountOptions) => {
      const selector = await (page as any)._wrapApiCall(async () => {
        return await innerMount(page, componentRef, options);
      }, true);
      const locator = page.locator(selector);
      return Object.assign(locator, {
        unmount: async () => {
          await locator.evaluate(async () => {
            const rootElement = document.getElementById('root')!;
            await window.playwrightUnmount(rootElement);
          });
        },
        update: async (options: JsxComponent | ObjectComponentOptions) => {
          if (isJsxComponent(options))
            return await innerUpdate(page, options);
          await innerUpdate(page, componentRef, options);
        }
      });
    });
    boundCallbacksForMount = [];
  },
};

function isJsxComponent(component: any): component is JsxComponent {
  return typeof component === 'object' && component && component.__pw_type === 'jsx';
}

async function innerUpdate(page: Page, componentRef: JsxComponent | ImportRef, options: ObjectComponentOptions = {}): Promise<void> {
  const component = createComponent(componentRef, options);
  wrapFunctions(component, page, boundCallbacksForMount);

  await page.evaluate(async ({ component }) => {
    const unwrapFunctions = (object: any) => {
      for (const [key, value] of Object.entries(object)) {
        if (typeof value === 'string' && (value as string).startsWith('__pw_func_')) {
          const ordinal = +value.substring('__pw_func_'.length);
          object[key] = (...args: any[]) => {
            (window as any)['__ct_dispatch'](ordinal, args);
          };
        } else if (typeof value === 'object' && value) {
          unwrapFunctions(value);
        }
      }
    };

    unwrapFunctions(component);
    component = await window.__pwRegistry.resolveImports(component);
    const rootElement = document.getElementById('root')!;
    return await window.playwrightUpdate(rootElement, component);
  }, { component });
}

async function innerMount(page: Page, componentRef: JsxComponent | ImportRef, options: ObjectComponentOptions & MountOptions = {}): Promise<string> {
  const component = createComponent(componentRef, options);
  wrapFunctions(component, page, boundCallbacksForMount);

  // WebKit does not wait for deferred scripts.
  await page.waitForFunction(() => !!window.playwrightMount);

  const selector = await page.evaluate(async ({ component, hooksConfig }) => {
    const unwrapFunctions = (object: any) => {
      for (const [key, value] of Object.entries(object)) {
        if (typeof value === 'string' && (value as string).startsWith('__pw_func_')) {
          const ordinal = +value.substring('__pw_func_'.length);
          object[key] = (...args: any[]) => {
            (window as any)['__ct_dispatch'](ordinal, args);
          };
        } else if (typeof value === 'object' && value) {
          unwrapFunctions(value);
        }
      }
    };

    unwrapFunctions(component);
    let rootElement = document.getElementById('root');
    if (!rootElement) {
      rootElement = document.createElement('div');
      rootElement.id = 'root';
      document.body.appendChild(rootElement);
    }
    component = await window.__pwRegistry.resolveImports(component);
    await window.playwrightMount(component, rootElement, hooksConfig);

    return '#root >> internal:control=component';
  }, { component, hooksConfig: options.hooksConfig });
  return selector;
}

function createComponent(component: JsxComponent | ImportRef, options: ObjectComponentOptions = {}): Component {
  if (component.__pw_type === 'jsx')
    return component;
  return {
    __pw_type: 'object-component',
    type: component,
    ...options,
  };
}

function wrapFunctions(object: any, page: Page, callbacks: Function[]) {
  for (const [key, value] of Object.entries(object)) {
    const type = typeof value;
    if (type === 'function') {
      const functionName = '__pw_func_' + callbacks.length;
      callbacks.push(value as Function);
      object[key] = functionName;
    } else if (type === 'object' && value) {
      wrapFunctions(value, page, callbacks);
    }
  }
}
