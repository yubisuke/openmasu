# The Unity bridge discovers this optional provider without a compile-time dependency.
-keep class dev.openmasu.sdk.installreferrer.GooglePlayReferrerReader {
    public <init>(android.content.Context, long);
}
