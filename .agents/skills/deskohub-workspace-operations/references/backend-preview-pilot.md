# Run the backend preview pilot

Dispatch `workspace-backend-preview.yml` from protected `main`. The dedicated GitHub environment and Google federation must admit only that workflow. Approve one internal PR, its exact head, and its immutable Workspace Preview deployment. The pilot uses separate Cloud Run services, credentials, and Alchemy state from sandbox smoke.

## Configure the reviewed PR

1. Confirm the pilot PR targets `main` and the Neon/Vercel integration created the approved non-primary `preview/<head-ref>` branch. Set `WORKSPACE_BACKEND_PREVIEW_NEON_BRANCH_ID` to its branch ID in both `workspace-backend-preview` and `workspace-checkout-e2e`. The integration creates and deletes the Neon branch. Apply the preview data policy in `AGENTS.md` and scope fixtures to synthetic data.
2. Set the repository variable `WORKSPACE_BACKEND_PREVIEW_PR` and the `workspace-backend-preview` environment variable `WORKSPACE_BACKEND_PREVIEW_APPROVED_PR` to the approved PR number. List `email-campaigns` in the PR's `## E2E flows` section. Admit only schema changes that let both generations start before the E2E migration.
3. Set `WORKSPACE_EMAIL_PREFERENCES_TRANSPORT=rpc` for the selected Vercel Preview branch. Set `WORKSPACE_API_ORIGIN` to the IAM-private API base service origin. Set `WORKSPACE_GCP_PROJECT_NUMBER` to the sandbox project number, `WORKSPACE_WIF_POOL` to `workspace-vercel`, `WORKSPACE_WIF_PROVIDER` to `vercel`, and `WORKSPACE_FRONTEND_SERVICE_ACCOUNT` to the preview invoker. Keep Deployment Protection and Vercel system environment variables enabled.
4. Set `WORKSPACE_BACKEND_PREVIEW_VERCEL_TOKEN` in `workspace-checkout-e2e` to the preview deployment metadata credential. Use the same Preview-only versioned `BETTER_AUTH_SECRETS` for the protected Vercel branch, the Cloud Run preview signing secret, and the E2E signing fixture. Keep all connection strings, protected origins, identity tokens, and mailing links out of logs and evidence artifacts.

## Verify the transition from A to B

1. Build the protected Git preview for commit A. From `main`, dispatch the bootstrap workflow with `operation=deploy`, `pr_number`, `head_sha`, and `vercel_deployment_id`. Approve each fresh dispatch in the protected environment. Record the API revision and worker tag from the trusted readback. Confirm A receives zero default traffic.
2. Push commit B and wait for its immutable Vercel deployment. Before deploying B, verify its preview probe reports that the backend generation is unavailable. The existing E2E suite waits for a generation before taking the preview database lease.
3. Deploy B through the same workflow. Run `Workspace E2E` with `sha` set to B, `url` set to its immutable Vercel origin, `ref` set to the pilot branch, and `flows=email-campaigns`. For a manual proof before the feature PR lands, dispatch the reviewed E2E workflow ref with the existing preview-fixture environment. Dispatch the privileged deploy from `main`.
4. Verify the E2E run checks the approved Neon branch under the lease before migrating. Compare the API revision and worker tag with the trusted deploy readback. The Vercel gateway gets a token for the base service audience and sends the request to the tagged URL. The synthetic unsubscribe GET and POST must each report B. The GET preserves consent and the POST withdraws it in the approved Neon branch. The case removes its synthetic rows.
5. Use the run interval and API revision to find Cloud Run request logs for `POST /rpc/preview` as a positive control. Inspect the relevant logs and spans for the synthetic marker `preview-unsubscribe-<GitHub run ID>-<attempt>`, unsubscribe token material, and token-bearing locations. Record the controls and pass or failure without including sensitive values. Follow the [diagnostics redaction rules](diagnostics.md).

The preview binds a worker destination for each generation. VS#1 uses synchronous RPC and schedules no work. Non-pilot previews and frontend-only PRs keep local transport. A future shared backend baseline requires affirmative changed-path classification and an approved branch binding.

## Tear down the pilot

Close the PR and dispatch `operation=cleanup` from the reviewed `main` workflow. Set `pr_number` to the pilot number and `head_sha` to the full final commit SHA. Leave `vercel_deployment_id` empty. The workflow verifies the pilot and its generation before removing its dedicated services, tags and revisions, database secret versions, and pilot images. Verify that the integration removed its obsolete Neon branch.

Read back the preview inventory and compare the sandbox proof inventory with its baseline. Remove pilot-only Vercel and GitHub configuration after cleanup. Retire the preview federation and accounts, signing and database secrets, preview registry repository, and the state bucket and its noncurrent objects. Record the gross and credited spend against the pilot cap and teardown date.
