# Working notes for this repo

## Handing Anthony code to deploy

Anthony deploys by hand: Supabase Edge Functions through the dashboard
editor, SQL through the SQL editor. Two rules, both from him:

**Always the whole file. Never a patch.** No "find this line and change
it", no "paste this block after that one". Select all, paste, deploy.
Partial edits in a web editor are how a function ends up half-deployed
with nobody sure which half.

**Always a GitHub URL. Never an attached file.** Link the file on `main`
and let him use GitHub's "Copy raw file" button. The file cards truncate
— a 310-line Edge Function came back as 150 lines and Deno rejected it
with "Unexpected eof", which reads like a syntax error and is not one.

So the shape of a hand-off is:

> Redeploy `punch`:
> https://github.com/AnthonyAngOLY/mystarswim.com/blob/main/supabase/functions/punch/index.ts

Which means the change has to be **on `main` before you link it**. Ask
to merge first, then give the link.

Where order matters between a function deploy and a SQL run, say which
goes first and what breaks if they are swapped.

## Pushing

Ask before merging to `main` — his instruction, after a stretch where
work sat on a feature branch that Netlify does not build. Netlify builds
`main`; a push to the feature branch deploys nothing.

Develop on `claude/mystarswim-onboarding-9ytsvz`.

## The admin bundle

`app.js` is JSX and is **not** what the browser loads. `app.compiled.js`
is, and it is committed. After editing `app.js`, rebuild:

```
node build.js app.js app.compiled.js
```

with Babel configured as `@babel/preset-react` `{useSpread:true}`,
`compact:false`, `comments:true`,
`generatorOpts:{jsescOption:{minimal:true}}`. Those settings reproduce
the existing file byte-for-byte; without `jsescOption.minimal` every
box-drawing comment escapes to `\uXXXX` and the diff explodes.

A clean rebuild shows only the lines you changed. If the diff is larger
than your edit, the Babel settings are wrong — fix them rather than
committing the noise.

## Records

Void, do not delete. Attendance, leave and voucher history is the point
of the system. The one documented exception is the test-data purge
script, which says so in its own header.
