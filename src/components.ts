/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineComponents } from '@iwsdk/core';
import { Robot } from './robot-component.js';
import { AgentTag, ButtonTag, CardTag, CoreTag } from './handcrew-components.js';

export default defineComponents([Robot, CoreTag, AgentTag, CardTag, ButtonTag]);
