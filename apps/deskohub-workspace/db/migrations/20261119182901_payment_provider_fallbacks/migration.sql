CREATE TABLE "payment_provider_fallbacks" (
	"deployment_host_hash" text PRIMARY KEY,
	CONSTRAINT "payment_provider_fallbacks_deployment_host_hash_check" CHECK ("deployment_host_hash" ~ '^[0-9a-f]{64}$')
);
