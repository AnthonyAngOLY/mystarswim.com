// The declaration page talks to the same three things the intake form
// does — the branches list, terms_for and public-intake — so it is the
// same mock, on its own port so the two suites can run side by side.
//
// A copy of intakemock.js would have been quicker and would have drifted
// the first time the lookup response changed, which is the fault this
// repository keeps finding in its own history.
'use strict';
process.env.PORT = process.env.PORT || '8905';
require('./intakemock.js');
