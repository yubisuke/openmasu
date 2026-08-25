# The Unity bridge discovers this optional provider without a compile-time dependency.
-keep class dev.openmasu.sdk.metareferrer.MetaInstallReferrerReader {
    public <init>(android.content.ContentResolver, java.lang.String);
}
