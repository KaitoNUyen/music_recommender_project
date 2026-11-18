import React from 'react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="error-boundary-container" role="alert">
          <div className="error-boundary-card">
            <div className="error-icon">⚠️</div>
            <h2>Đã xảy ra lỗi giao diện</h2>
            <p className="error-desc">
              Một thành phần đã gặp lỗi không mong muốn. Dữ liệu của bạn không bị mất.
            </p>
            {this.state.error && (
              <details className="error-details">
                <summary>Chi tiết kỹ thuật</summary>
                <pre>{this.state.error.toString()}</pre>
                {this.state.errorInfo?.componentStack && (
                  <pre>{this.state.errorInfo.componentStack}</pre>
                )}
              </details>
            )}
            <div className="error-actions">
              <button className="btn btn-primary" onClick={this.handleReset}>
                Thử lại
              </button>
              <button className="btn btn-secondary" onClick={this.handleReload}>
                Tải lại trang
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
