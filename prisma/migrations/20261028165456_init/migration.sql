-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CheckTrigger" AS ENUM ('ENROLLMENT', 'SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CheckOutcome" AS ENUM ('BASELINE', 'CHANGED', 'UNCHANGED', 'STALE_DISCARDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FailureCategory" AS ENUM ('CARRIER_TIMEOUT', 'CARRIER_UNAVAILABLE', 'CARRIER_RATE_LIMITED', 'CARRIER_AUTH_FAILED', 'CARRIER_REQUEST_REJECTED', 'CARRIER_DATA_UNAVAILABLE', 'POLICY_NOT_FOUND', 'INVALID_CARRIER_RESPONSE', 'INTERNAL_ERROR');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('POLICY_CANCELLED', 'POLICY_REINSTATED', 'POLICY_RENEWED', 'POLICY_EXPIRED', 'COVERAGE_CHANGED', 'PREMIUM_CHANGED', 'VEHICLE_ADDED', 'VEHICLE_REMOVED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCESS', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'BLOCKED_DESTINATION');

-- CreateEnum
CREATE TYPE "DeliveryTrigger" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "external_policy_id" TEXT NOT NULL,
    "status" "PolicyStatus",
    "policy_type" TEXT,
    "effective_date" DATE,
    "expiration_date" DATE,
    "premium_cents" INTEGER,
    "premium_currency" CHAR(3),
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "monitoring_enabled" BOOLEAN NOT NULL DEFAULT true,
    "check_interval_seconds" INTEGER NOT NULL,
    "next_check_at" TIMESTAMPTZ(3) NOT NULL,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_successful_check_at" TIMESTAMPTZ(3),
    "last_check_outcome" "CheckOutcome",
    "last_failure_category" "FailureCategory",
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_snapshots" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "data" JSONB NOT NULL,
    "retrieved_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_checks" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "trigger" "CheckTrigger" NOT NULL,
    "outcome" "CheckOutcome" NOT NULL,
    "failure_category" "FailureCategory",
    "error_message" TEXT,
    "http_status" INTEGER,
    "snapshot_version" INTEGER,
    "events_generated" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL,
    "correlation_id" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "policy_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_events" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "external_policy_id" TEXT NOT NULL,
    "event_type" "EventType" NOT NULL,
    "schema_version" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "previous_version" INTEGER NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "event_types" TEXT[],
    "carrier_ids" TEXT[],
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "secret_ciphertext" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "manual_retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "enqueued_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_response_status" INTEGER,
    "last_error" TEXT,
    "succeeded_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "trigger" "DeliveryTrigger" NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "destination_host" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body_snippet" TEXT,
    "error_message" TEXT,
    "signature_timestamp" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policies_monitoring_enabled_next_check_at_idx" ON "policies"("monitoring_enabled", "next_check_at");

-- CreateIndex
CREATE INDEX "policies_carrier_id_id_idx" ON "policies"("carrier_id", "id");

-- CreateIndex
CREATE INDEX "policies_status_id_idx" ON "policies"("status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_carrier_id_external_policy_id_key" ON "policies"("carrier_id", "external_policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_snapshots_policy_id_version_key" ON "policy_snapshots"("policy_id", "version");

-- CreateIndex
CREATE INDEX "policy_checks_policy_id_id_idx" ON "policy_checks"("policy_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_events_dedupe_key_key" ON "policy_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "policy_events_policy_id_id_idx" ON "policy_events"("policy_id", "id");

-- CreateIndex
CREATE INDEX "policy_events_event_type_id_idx" ON "policy_events"("event_type", "id");

-- CreateIndex
CREATE INDEX "policy_events_carrier_id_id_idx" ON "policy_events"("carrier_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_event_id_key" ON "outbox_messages"("event_id");

-- CreateIndex
CREATE INDEX "outbox_messages_status_available_at_idx" ON "outbox_messages"("status", "available_at");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_status_idx" ON "webhook_subscriptions"("status");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_subscription_id_id_idx" ON "webhook_deliveries"("subscription_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_subscription_id_event_id_key" ON "webhook_deliveries"("subscription_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_number_key" ON "delivery_attempts"("delivery_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "policy_snapshots" ADD CONSTRAINT "policy_snapshots_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_checks" ADD CONSTRAINT "policy_checks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_events" ADD CONSTRAINT "policy_events_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "policy_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "policy_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
