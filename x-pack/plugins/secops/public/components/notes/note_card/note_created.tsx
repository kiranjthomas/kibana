/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { FormattedRelative } from '@kbn/i18n/react';
import * as React from 'react';
import { pure } from 'recompose';

import { LocalizedDateTooltip } from '../../localized_date_tooltip';
import { SelectableText } from '../../selectable_text';

export const NoteCreated = pure<{ created: Date }>(({ created }) => (
  <SelectableText data-test-subj="note-created">
    <LocalizedDateTooltip date={created}>
      <FormattedRelative value={created} />
    </LocalizedDateTooltip>
  </SelectableText>
));
