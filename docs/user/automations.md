# Automations

Automations start a fresh agent thread on a recurring schedule. Open **Settings → Automations** to create and manage them.

An automation saves the same choices available when starting a normal chat:

- project, prompt, and attachments;
- provider instance, model, reasoning effort, service tier, and other model options;
- access and interaction modes;
- project checkout, an existing worktree, or a new worktree created from a chosen branch.

Enter a standard five-field CRON expression and an IANA time zone. For example, `0 9 * * 1-5` runs at 9:00 AM every weekday in the selected time zone. Seconds and Quartz-only CRON extensions are not supported.

The environment that owns the project also owns the schedule. It must be running when an occurrence is due. If it was offline, missed occurrences are combined into one catch-up run when it returns instead of being replayed individually.

## Runs and overlap

Every occurrence creates a separate, fresh thread. Automation threads appear in the normal sidebar and archive with blue titles. Open **History** on an automation to see its prior runs and jump to their threads.

Runs never overlap. If an earlier scheduled run is still active, the next occurrence is recorded as skipped. **Run now** also refuses to start while a run is active.

If a project or workspace configuration becomes invalid, the automation pauses and shows the reason. Edit the configuration, then enable it again. You can also pause, resume, edit, run, or delete any automation from the Automations settings page.
