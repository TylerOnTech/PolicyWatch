# ---------------------------------------------------------------------------------------- log group
resource "aws_cloudwatch_log_group" "app" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------------------------- metric filters
# The application logs one JSON object per line (pino). Metric filters turn specific log lines into
# CloudWatch metrics without shipping a metrics agent for application data.

locals {
  metric_namespace = "PolicyWatch"
  metric_filters = {
    ErrorLogLines = {
      pattern = "{ $.level >= 50 }"
    }
    WebhookDeliveryFailures = {
      pattern = "{ $.msg = \"webhook delivery failed permanently\" }"
    }
    WebhookRetriesScheduled = {
      pattern = "{ $.msg = \"webhook attempt failed; retry scheduled\" }"
    }
    PolicyCheckFailures = {
      pattern = "{ $.msg = \"policy check failed; stored policy state left unchanged\" }"
    }
    BackgroundLoopErrors = {
      pattern = "{ $.msg = \"background loop iteration failed\" }"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "app" {
  for_each = local.metric_filters

  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = each.value.pattern

  metric_transformation {
    name          = each.key
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

# ------------------------------------------------------------------------------------------- alarms
resource "aws_sns_topic" "alarms" {
  count             = var.enable_alarms ? 1 : 0
  name              = "${local.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.enable_alarms && var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = var.enable_alarms ? [aws_sns_topic.alarms[0].arn] : []
}

# Host failure → EC2 auto-recovery (same instance ID, EIP and EBS) plus a notification.
resource "aws_cloudwatch_metric_alarm" "system_status" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-system-status-check"
  alarm_description   = "Underlying host failure; EC2 recovers the instance automatically."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = concat(["arn:aws:automate:${var.aws_region}:ec2:recover"], local.alarm_actions)
}

resource "aws_cloudwatch_metric_alarm" "webhook_failures" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-webhook-permanent-failures"
  alarm_description   = "Webhook deliveries exhausting retries or failing permanently."
  namespace           = local.metric_namespace
  metric_name         = "WebhookDeliveryFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.app]
}

resource "aws_cloudwatch_metric_alarm" "error_logs" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-error-log-rate"
  alarm_description   = "Sustained error-level log lines from any PolicyWatch container."
  namespace           = local.metric_namespace
  metric_name         = "ErrorLogLines"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.app]
}

# ---------------------------------------------------------------------------------------- backups
# PostgreSQL lives on the root volume; daily crash-consistent snapshots bound data loss to 24 h.
data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  count              = var.enable_daily_snapshots ? 1 : 0
  name               = "${local.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  count      = var.enable_daily_snapshots ? 1 : 0
  role       = aws_iam_role.dlm[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "daily" {
  count              = var.enable_daily_snapshots ? 1 : 0
  description        = "${local.name} daily root-volume snapshots"
  execution_role_arn = aws_iam_role.dlm[0].arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Snapshot = "${local.name}-daily" }

    schedule {
      name = "daily-7"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule {
        count = 7
      }
      copy_tags = true
    }
  }
}
