import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

const SITE_SOURCE_DIR = path.join(__dirname, "../../../src/price-check-site");

// Browser Tool's mock price-check site (issue #19 / ADR-0005): a single
// static HTML page, CDK-deployed to an S3 static website, with prices
// computed client-side and randomized independently of Gateway's mock
// catalog (issue #3/#15) — a real travel site would need anti-bot/CAPTCHA
// mitigation this learning task is out of scope for.
export class PriceCheckSiteConstruct extends cdk.Resource {
  public readonly bucket: s3.Bucket;
  public readonly siteUrl: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "SiteBucket", {
      websiteIndexDocument: "index.html",
      // Public read is granted via bucket policy (below), never ACLs — keep
      // ACL-based public access blocked and only relax the policy-based
      // restrictions this bucket actually needs.
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "SiteDeployment", {
      sources: [s3deploy.Source.asset(SITE_SOURCE_DIR)],
      // aws-cdk-lib's IBucket/Bucket typings disagree on `isWebsite`'s
      // optionality under this project's exactOptionalPropertyTypes — a
      // typing-only mismatch, not a real incompatibility (Bucket implements
      // IBucket at runtime).
      destinationBucket: this.bucket as s3.IBucket,
    });

    this.siteUrl = `http://${this.bucket.bucketWebsiteDomainName}`;
  }
}
