Checks that a new version of the app opens the data the previous version wrote, with the same
logins, and that rolling back still works. Not part of `npm run test:tz` (it needs two copies of the code).

    mkdir -p /tmp/mig/old /tmp/mig/new /tmp/mig/data
    git archive <previous-commit> | tar -x -C /tmp/mig/old ; git archive HEAD | tar -x -C /tmp/mig/new
    # give each copy node_modules and make its data/ a symlink to /tmp/mig/data
    cp test/migration/fake.mjs /tmp/mig/ ; cp test/migration/phase*.mjs /tmp/mig/
    (cd /tmp/mig/old && cp ../phase1.mjs . && node phase1.mjs)   # previous version builds a realistic team
    (cd /tmp/mig/new && cp ../phase2.mjs . && node phase2.mjs)   # new version: same cookies, everything unchanged
    (cd /tmp/mig/old && cp ../phase3.mjs . && node phase3.mjs)   # rollback: previous version on the new data

The paths inside the phase files point at /tmp/mig (written as /private/tmp/mig on macOS).
